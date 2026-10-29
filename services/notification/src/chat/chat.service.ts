import { Injectable, Logger } from '@nestjs/common';
import {
  type ActingOrganization,
  badRequest,
  CommerceClient,
  DocumentsClient,
  LogisticsClient,
  forbidden,
  notFound,
  OrganizationsClient,
  type PaginationQueryDto,
  skipTake,
  toPage,
} from '@uboce/common';
import type { EventEnvelope } from '@uboce/contracts';

import type { Prisma } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma.service.js';

const CONTEXTS = ['rfq', 'quotation', 'order', 'shipment', 'dispute', 'general'] as const;
export type ContextType = (typeof CONTEXTS)[number];
/** Who hears about new chat messages in an organization. */
const CHAT_ROLES = ['owner', 'admin', 'procurement_officer', 'sales_representative', 'logistics_operator', 'finance_officer'];

export interface StartConversationInput {
  subject: string;
  contextType: ContextType;
  contextId?: string;
  participantOrganizationIds: string[];
  message: string;
  attachmentDocumentIds?: string[];
}

/**
 * Chat between organizations (PRD addendum 2.9). Participants are organizations, so
 * colleagues share a conversation and access ends when someone leaves the organization.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsClient,
    private readonly commerce: CommerceClient,
    private readonly logistics: LogisticsClient,
    private readonly documents: DocumentsClient,
    private readonly notifications: NotificationsService,
  ) {}

  async start(org: ActingOrganization, userId: string, input: StartConversationInput) {
    const others = [...new Set(input.participantOrganizationIds.filter((id) => id !== org.organization.id))];
    if (!others.length) throw badRequest('no_participants', 'Add at least one other organization');
    if (others.length > 20) throw badRequest('too_many_participants', 'At most 20 organizations per conversation');
    for (const id of others) {
      const o = await this.organizations.getOrganization(id);
      if (!o || o.status !== 'active') throw badRequest('unknown_organization', 'An organization does not exist or is inactive');
    }
    await this.checkContext(org.organization.id, input.contextType, input.contextId, others);

    // An order already has its conversation: reuse it instead of starting parallel threads.
    if (input.contextType !== 'general' && input.contextId) {
      const existing = await this.prisma.conversation.findFirst({
        where: { contextType: input.contextType, contextId: input.contextId, participants: { some: { organizationId: org.organization.id } } },
      });
      if (existing) {
        await this.send(org, userId, existing.id, { body: input.message, attachmentDocumentIds: input.attachmentDocumentIds });
        return this.get(org, existing.id);
      }
    }

    const conversation = await this.prisma.conversation.create({
      data: {
        subject: input.subject.trim(),
        contextType: input.contextType,
        contextId: input.contextId ?? null,
        createdByUserId: userId,
        createdByOrganizationId: org.organization.id,
        participants: { create: [org.organization.id, ...others].map((organizationId) => ({ organizationId, lastReadAt: organizationId === org.organization.id ? new Date() : null })) },
      },
    });
    await this.send(org, userId, conversation.id, { body: input.message, attachmentDocumentIds: input.attachmentDocumentIds });
    return this.get(org, conversation.id);
  }

  /** My organization's conversations, most recent first, with unread counts. */
  async list(org: ActingOrganization, query: PaginationQueryDto & { contextType?: string; contextId?: string }) {
    const where: Prisma.ConversationWhereInput = {
      participants: { some: { organizationId: org.organization.id } },
      ...(query.contextType ? { contextType: query.contextType } : {}),
      ...(query.contextId ? { contextId: query.contextId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.conversation.findMany({
        where,
        include: { participants: true, messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
        orderBy: { lastMessageAt: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.conversation.count({ where }),
    ]);
    const withUnread = await Promise.all(
      items.map(async (c) => {
        const me = c.participants.find((p) => p.organizationId === org.organization.id);
        const unread = await this.prisma.chatMessage.count({
          where: { conversationId: c.id, senderOrganizationId: { not: org.organization.id }, deletedAt: null, ...(me?.lastReadAt ? { createdAt: { gt: me.lastReadAt } } : {}) },
        });
        const { messages, ...rest } = c;
        return { ...rest, lastMessage: messages[0] ?? null, unread };
      }),
    );
    return toPage(withUnread, total, query);
  }

  async unreadCount(org: ActingOrganization) {
    const mine = await this.prisma.conversationParticipant.findMany({ where: { organizationId: org.organization.id } });
    let unread = 0;
    for (const p of mine) {
      unread += await this.prisma.chatMessage.count({
        where: { conversationId: p.conversationId, senderOrganizationId: { not: org.organization.id }, deletedAt: null, ...(p.lastReadAt ? { createdAt: { gt: p.lastReadAt } } : {}) },
      });
    }
    return { unread };
  }

  async get(org: ActingOrganization, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, participants: { some: { organizationId: org.organization.id } } },
      include: { participants: true },
    });
    if (!conversation) throw notFound('Conversation');
    return conversation;
  }

  /** Messages, oldest first. `after` returns only newer messages (for polling). */
  async messages(org: ActingOrganization, conversationId: string, query: { after?: string; limit?: number }) {
    await this.get(org, conversationId);
    const limit = Math.min(query.limit ?? 100, 200);
    const rows = await this.prisma.chatMessage.findMany({
      where: { conversationId, ...(query.after ? { createdAt: { gt: new Date(query.after) } } : {}) },
      orderBy: { createdAt: query.after ? 'asc' : 'desc' },
      take: limit,
    });
    const ordered = query.after ? rows : rows.reverse();
    return ordered.map((m) => (m.deletedAt ? { ...m, body: '', attachmentDocumentIds: [] } : m));
  }

  async send(org: ActingOrganization, userId: string, conversationId: string, input: { body: string; attachmentDocumentIds?: string[] }) {
    const conversation = await this.get(org, conversationId);
    if (conversation.closedAt) throw forbidden('This conversation is closed');
    const body = input.body.trim();
    if (!body && !input.attachmentDocumentIds?.length) throw badRequest('empty_message', 'Write a message or attach a file');
    const others = conversation.participants.map((p) => p.organizationId).filter((id) => id !== org.organization.id);

    // Attachments must be ours; the other participants get read access to them.
    for (const id of input.attachmentDocumentIds ?? []) {
      const doc = await this.documents.get(id);
      if (!doc || doc.ownerOrganizationId !== org.organization.id || doc.status !== 'available') throw badRequest('invalid_attachment', 'Attach documents uploaded by your organization');
      for (const other of others) await this.documents.grant(id, { type: 'organization', id: other }, `chat ${conversationId}`);
    }

    const now = new Date();
    const message = await this.prisma.$transaction(async (tx) => {
      const m = await tx.chatMessage.create({
        data: { conversationId, senderUserId: userId, senderOrganizationId: org.organization.id, body, attachmentDocumentIds: input.attachmentDocumentIds ?? [] },
      });
      await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: now } });
      await tx.conversationParticipant.update({ where: { conversationId_organizationId: { conversationId, organizationId: org.organization.id } }, data: { lastReadAt: now } });
      return m;
    });

    // Notify the other organizations' relevant members (in-app + push), once per message.
    const envelope = { eventId: message.id, eventType: 'ChatMessageSent' } as unknown as EventEnvelope;
    await this.notifications
      .handleEventOnce(envelope, {
        recipients: async () => {
          const lists = await Promise.all(others.map((id) => this.organizations.listMembers(id, CHAT_ROLES)));
          const userIds = new Set(lists.flat().map((m) => m.userId));
          userIds.delete(userId);
          return [...userIds].map((u) => ({
            userId: u,
            template: 'chat_message' as const,
            vars: { conversationId, subject: conversation.subject, organizationName: org.organization.name, preview: body.slice(0, 80) },
          }));
        },
      })
      .catch((error) => this.logger.warn(`Chat notification failed: ${(error as Error).message}`));
    return message;
  }

  async markRead(org: ActingOrganization, conversationId: string) {
    await this.get(org, conversationId);
    await this.prisma.conversationParticipant.update({
      where: { conversationId_organizationId: { conversationId, organizationId: org.organization.id } },
      data: { lastReadAt: new Date() },
    });
    return { read: true };
  }

  /** The sender withdraws a message (the slot stays so the thread doesn't jump). */
  async deleteMessage(org: ActingOrganization, userId: string, conversationId: string, messageId: string) {
    const message = await this.prisma.chatMessage.findFirst({ where: { id: messageId, conversationId, senderOrganizationId: org.organization.id } });
    if (!message) throw notFound('Message');
    if (message.senderUserId !== userId && !['owner', 'admin'].includes(org.role)) throw forbidden('Only the sender or an admin can delete a message');
    await this.prisma.chatMessage.update({ where: { id: messageId }, data: { deletedAt: new Date() } });
    return { deleted: true };
  }

  async close(org: ActingOrganization, conversationId: string) {
    await this.get(org, conversationId);
    return this.prisma.conversation.update({ where: { id: conversationId }, data: { closedAt: new Date() } });
  }

  /** Order conversations are only between the order's buyer and supplier. */
  private async checkContext(organizationId: string, type: ContextType, contextId: string | undefined, others: string[]) {
    if (!CONTEXTS.includes(type)) throw badRequest('invalid_context', 'Unknown conversation context');
    if (type === 'general') return;
    if (!contextId) throw badRequest('context_required', `Say which ${type} this is about`);
    if (type === 'shipment') {
      // Shipper, buyer and the logistics provider carrying it.
      const s = await this.logistics.getShipment(contextId);
      const parties = s ? [s.shipperOrganizationId, s.consigneeOrganizationId, ...(s.carrierOrganizationId ? [s.carrierOrganizationId] : [])] : [];
      if (!s || !parties.includes(organizationId) || others.some((o) => !parties.includes(o))) throw notFound('Shipment');
    }
    if (type === 'order') {
      const order = await this.commerce.getOrder(contextId);
      const parties = order ? [order.buyerOrganizationId, order.supplierOrganizationId] : [];
      if (!order || !parties.includes(organizationId) || others.some((o) => !parties.includes(o))) throw notFound('Order');
    }
  }
}
