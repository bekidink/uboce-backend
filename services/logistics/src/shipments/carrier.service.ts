import { Injectable } from '@nestjs/common';
import { type ActingOrganization, badRequest, conflict, notFound, requireRole } from '@uboce/common';
import type { InternalShipment } from '@uboce/contracts';

import { PrismaService } from '../prisma.service.js';
import { CARRIER_ROLES, include, SHIPPER_ROLES, ShipmentsService } from './shipments.service.js';

/**
 * Supplier ↔ logistics provider hand-off (PRD addendum 2.8): the shipper names a
 * logistics provider; the provider accepts or declines, then runs the delivery with its
 * own drivers and posts tracking. The buyer still confirms what arrived.
 */
@Injectable()
export class CarrierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
  ) {}

  /** Shipper: hand the shipment to a logistics provider (or take it back) before it leaves. */
  async setCarrier(org: ActingOrganization, shipmentId: string, carrierOrganizationId: string | null) {
    requireRole(org, SHIPPER_ROLES, 'choose carriers');
    const s = await this.shipments.owned(org, shipmentId, 'shipper');
    if (!['created', 'assigned', 'ready_for_pickup'].includes(s.status)) throw conflict('already_dispatched', 'The carrier can only change before dispatch');
    if (carrierOrganizationId) await this.shipments.checkCarrierOrg(org, carrierOrganizationId);
    if (s.carrierOrganizationId === carrierOrganizationId) return s;
    return this.prisma.$transaction(async (tx) => {
      if (s.carrierOrganizationId) await this.shipments.announceCarrier(tx, s, 'removed', null);
      const updated = await tx.shipment.update({
        where: { id: s.id },
        data: { carrierOrganizationId, carrierStatus: carrierOrganizationId ? 'requested' : 'none', carrierNote: null },
        include,
      });
      // The previous provider's drivers are no longer on this shipment.
      await tx.driverAssignment.updateMany({ where: { shipmentId: s.id, status: { in: ['assigned', 'accepted'] }, driver: { organizationId: { not: org.organization.id } } }, data: { status: 'cancelled' } });
      if (carrierOrganizationId) await this.shipments.announceCarrier(tx, updated, 'requested', null);
      return updated;
    });
  }

  /** Logistics provider: accept or decline a shipment it was asked to carry. */
  async respond(org: ActingOrganization, shipmentId: string, decision: 'accept' | 'decline', note?: string) {
    requireRole(org, CARRIER_ROLES, 'accept shipments');
    const s = await this.shipments.owned(org, shipmentId, 'carrier');
    if (s.carrierStatus !== 'requested') throw conflict('already_answered', `You already ${s.carrierStatus} this shipment`);
    if (decision === 'decline' && !note?.trim()) throw badRequest('reason_required', 'Tell the shipper why you decline');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.shipment.update({
        where: { id: s.id },
        data: { carrierStatus: decision === 'accept' ? 'accepted' : 'declined', carrierNote: note?.trim() || null },
        include,
      });
      await this.shipments.announceCarrier(tx, updated, decision === 'accept' ? 'accepted' : 'declined', note?.trim() || null, s.carrierOrganizationId!);
      return updated;
    });
  }

  async internalGet(shipmentId: string): Promise<InternalShipment> {
    const s = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!s) throw notFound('Shipment');
    return {
      id: s.id,
      orderNumber: s.orderNumber,
      shipperOrganizationId: s.shipperOrganizationId,
      consigneeOrganizationId: s.consigneeOrganizationId,
      carrierOrganizationId: s.carrierStatus === 'accepted' || s.carrierStatus === 'requested' ? s.carrierOrganizationId : null,
      status: s.status,
    };
  }
}
