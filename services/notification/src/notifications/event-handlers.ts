import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { OrganizationsClient, REDIS, StreamConsumer } from '@uboce/common';
import type { DomainEvent, EventEnvelope, EventType } from '@uboce/contracts';
import type { Redis } from 'ioredis';

import { SERVICE_NAME } from '../config.js';
import { type NotifyRequest, NotificationsService, type Tx } from './notifications.service.js';
import type { TemplateKey } from './templates.js';

// Who hears about what, by role in the organization concerned.
const SALES_ROLES = ['owner', 'admin', 'sales_representative'];
const BUYING_ROLES = ['owner', 'admin', 'procurement_officer'];

const formatDate = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/** Turns other services' domain events into notifications. */
@Injectable()
export class NotificationEventHandlers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(NotificationEventHandlers.name);
  private readonly consumer: StreamConsumer;

  constructor(
    @Inject(REDIS) redis: Redis,
    private readonly notifications: NotificationsService,
    private readonly organizations: OrganizationsClient,
  ) {
    this.consumer = new StreamConsumer(redis, {
      group: SERVICE_NAME,
      handlers: {
        UserRegistered: this.on('UserRegistered', async (e) => [{ userId: e.data.userId, template: 'welcome', vars: { name: e.data.displayName } }], {
          inTransaction: (e, tx) => this.notifications.setLocale(tx, e.data.userId, e.data.locale),
        }),
        OrganizationCreated: this.on('OrganizationCreated', async (e) => [
          {
            userId: e.data.createdByUserId,
            template: 'organization_created',
            vars: { organizationName: e.data.name, organizationId: e.data.organizationId },
          },
        ]),
        // Being added by someone else is news; adding yourself (as creator) isn't.
        MembershipAdded: this.on('MembershipAdded', async (e) =>
          e.data.addedByUserId === e.data.userId
            ? []
            : [{ userId: e.data.userId, template: 'membership_added', vars: { role: e.data.role, organizationId: e.data.organizationId } }],
        ),
        MembershipRevoked: this.on('MembershipRevoked', async (e) =>
          e.data.revokedByUserId === e.data.userId ? [] : [{ userId: e.data.userId, template: 'membership_revoked', vars: {} }],
        ),
        // Open RFQs (no invitations) are found through Discovery instead of notifications.
        RFQPublished: this.on('RFQPublished', async (e) =>
          this.toMembers(e.data.invitedSupplierOrganizationIds, SALES_ROLES, 'rfq_published', {
            rfqId: e.data.rfqId,
            title: e.data.title,
            deadline: formatDate(e.data.responseDeadline),
          }),
        ),
        QuotationSubmitted: this.on('QuotationSubmitted', async (e) =>
          this.toMembers([e.data.buyerOrganizationId], BUYING_ROLES, 'quotation_submitted', {
            rfqId: e.data.rfqId,
            total: e.data.total,
            currency: e.data.currency,
          }),
        ),
        PurchaseOrderCreated: this.on('PurchaseOrderCreated', async (e) =>
          this.toMembers([e.data.supplierOrganizationId], SALES_ROLES, 'purchase_order_created', {
            orderId: e.data.orderId,
            orderNumber: e.data.orderNumber,
            total: e.data.total,
            currency: e.data.currency,
          }),
        ),
        PurchaseOrderConfirmed: this.on('PurchaseOrderConfirmed', async (e) =>
          this.toMembers([e.data.buyerOrganizationId], BUYING_ROLES, 'purchase_order_confirmed', {
            orderId: e.data.orderId,
            orderNumber: e.data.orderNumber,
          }),
        ),
        PurchaseOrderCancelled: this.on('PurchaseOrderCancelled', async (e) => {
          const vars = { orderId: e.data.orderId, orderNumber: e.data.orderNumber };
          const [buyers, sellers] = await Promise.all([
            this.toMembers([e.data.buyerOrganizationId], BUYING_ROLES, 'purchase_order_cancelled', vars),
            this.toMembers([e.data.supplierOrganizationId], SALES_ROLES, 'purchase_order_cancelled', vars),
          ]);
          return [...buyers, ...sellers].filter((r) => r.userId !== e.data.changedByUserId);
        }),
        StockReservationFailed: this.on('StockReservationFailed', async (e) =>
          this.toMembers([e.data.organizationId], [...SALES_ROLES, 'warehouse_operator'], 'stock_reservation_failed', { orderId: e.data.orderId }),
        ),
        ShipmentDispatched: this.on('ShipmentDispatched', async (e) =>
          this.toMembers([e.data.consigneeOrganizationId], [...BUYING_ROLES, 'warehouse_operator', 'logistics_operator'], 'shipment_dispatched', { shipmentId: e.data.shipmentId }),
        ),
        DeliveryConfirmed: this.on('DeliveryConfirmed', async (e) =>
          this.toMembers([e.data.shipperOrganizationId], [...SALES_ROLES, 'logistics_operator'], 'delivery_confirmed', {
            shipmentId: e.data.shipmentId,
            complete: String(e.data.complete),
          }),
        ),
        InvoiceIssued: this.on('InvoiceIssued', async (e) =>
          this.toMembers([e.data.buyerOrganizationId], [...BUYING_ROLES, 'finance_officer'], 'invoice_issued', {
            invoiceId: e.data.invoiceId,
            invoiceNumber: e.data.invoiceNumber,
            dueDate: formatDate(e.data.dueDate),
          }),
        ),
        DisputeOpened: this.on('DisputeOpened', async (e) =>
          this.toMembers([e.data.againstOrganizationId], ['owner', 'admin'], 'dispute_opened', { disputeId: e.data.disputeId }),
        ),
        KycVerificationDecided: this.on('KycVerificationDecided', async (e) =>
          e.data.decision === 'submitted' ? [] : [{ userId: e.data.subjectId, template: 'verification_update', vars: { kind: 'kyc', decision: e.data.decision } }],
        ),
        // ---- PRD addendum v1.1 ----
        PurchaseOrderFulfillmentUpdated: this.on('PurchaseOrderFulfillmentUpdated', async (e) =>
          ['ready_for_pickup', 'uncollected', 'delivery_failed', 'exception'].includes(e.data.status)
            ? this.toMembers([e.data.buyerOrganizationId], BUYING_ROLES, 'order_update', { orderId: e.data.orderId, orderNumber: e.data.orderNumber, status: e.data.status, side: 'buyer' })
            : [],
        ),
        ShipmentStatusChanged: this.on('ShipmentStatusChanged', async (e) =>
          ['delayed', 'failed'].includes(e.data.status)
            ? this.toMembers([e.data.consigneeOrganizationId, e.data.shipperOrganizationId, ...(e.data.carrierOrganizationId ? [e.data.carrierOrganizationId] : [])], [...BUYING_ROLES, ...SALES_ROLES, 'logistics_operator'], 'shipment_update', {
                shipmentId: e.data.shipmentId,
                status: e.data.status,
              })
            : [],
        ),
        ReturnRequested: this.on('ReturnRequested', async (e) =>
          this.toMembers([e.data.supplierOrganizationId], SALES_ROLES, 'return_requested', { returnId: e.data.returnId, orderNumber: e.data.orderNumber }),
        ),
        ReturnStatusChanged: this.on('ReturnStatusChanged', async (e) =>
          this.toMembers([e.data.buyerOrganizationId], BUYING_ROLES, 'return_update', { returnId: e.data.returnId, orderNumber: e.data.orderNumber, status: e.data.status }),
        ),
        RefundStatusChanged: this.on('RefundStatusChanged', async (e) =>
          ['succeeded', 'failed', 'rejected'].includes(e.data.status)
            ? this.toMembers([e.data.buyerOrganizationId], [...BUYING_ROLES, 'finance_officer'], 'refund_update', {
                refundId: e.data.refundId,
                amount: e.data.amount,
                currency: e.data.currency,
                status: e.data.status,
              })
            : this.toMembers([e.data.sellerOrganizationId], ['owner', 'admin', 'finance_officer'], 'refund_update', {
                refundId: e.data.refundId,
                amount: e.data.amount,
                currency: e.data.currency,
                status: e.data.status,
              }),
        ),
        OrderChargeAssessed: this.on('OrderChargeAssessed', async (e) =>
          this.toMembers([e.data.buyerOrganizationId], [...BUYING_ROLES, 'finance_officer'], 'fee_charged', {
            orderId: e.data.orderId,
            orderNumber: e.data.orderNumber,
            kind: e.data.kind.replace('_', ' '),
            amount: e.data.amount,
            currency: e.data.currency,
          }),
        ),
        QualityClaimOpened: this.on('QualityClaimOpened', async (e) =>
          this.toMembers([e.data.supplierOrganizationId], [...SALES_ROLES, 'quality_inspector'], 'claim_opened', { claimId: e.data.claimId, reason: e.data.reason }),
        ),
        ShipmentCarrierChanged: this.on('ShipmentCarrierChanged', async (e) => {
          if (e.data.status === 'requested') {
            const shipper = await this.organizations.getOrganization(e.data.shipperOrganizationId).catch(() => null);
            return this.toMembers([e.data.carrierOrganizationId], ['owner', 'admin', 'logistics_operator'], 'carrier_request', {
              shipmentId: e.data.shipmentId,
              orderNumber: e.data.orderNumber,
              organizationName: shipper?.name ?? 'A supplier',
            });
          }
          if (e.data.status === 'accepted' || e.data.status === 'declined') {
            return this.toMembers([e.data.shipperOrganizationId], [...SALES_ROLES, 'logistics_operator'], 'carrier_answer', {
              shipmentId: e.data.shipmentId,
              orderNumber: e.data.orderNumber,
              status: e.data.status,
              note: e.data.note ?? '',
            });
          }
          return [];
        }),
        ReviewPublished: this.on('ReviewPublished', async (e) =>
          this.toMembers([e.data.subjectOrganizationId], SALES_ROLES, 'review_published', { rating: String(e.data.rating) }),
        ),
        KybVerificationDecided: this.on('KybVerificationDecided', async (e) =>
          e.data.decision === 'submitted' ? [] : this.toMembers([e.data.subjectId], ['owner', 'admin'], 'verification_update', { kind: 'kyb', decision: e.data.decision }),
        ),
      },
    });
  }

  async onApplicationBootstrap() {
    await this.consumer.start();
  }

  async beforeApplicationShutdown() {
    await this.consumer.stop();
  }

  /** One notification per member with a relevant role, deduplicated across organizations. */
  private async toMembers(
    organizationIds: string[],
    roles: string[],
    template: TemplateKey,
    vars: Record<string, string>,
  ): Promise<NotifyRequest[]> {
    const lists = await Promise.all(organizationIds.map((id) => this.organizations.listMembers(id, roles)));
    const userIds = new Set(lists.flat().map((m) => m.userId));
    return [...userIds].map((userId) => ({ userId, template, vars }));
  }

  private on<T extends EventType>(
    _type: T,
    recipients: (event: DomainEvent<T>) => Promise<NotifyRequest[]>,
    options: { inTransaction?: (event: DomainEvent<T>, tx: Tx) => Promise<void> } = {},
  ) {
    return (event: EventEnvelope) => {
      const typed = event as DomainEvent<T>;
      return this.notifications.handleEventOnce(event, {
        recipients: () => recipients(typed),
        inTransaction: options.inTransaction ? (tx) => options.inTransaction!(typed, tx) : undefined,
      });
    };
  }
}
