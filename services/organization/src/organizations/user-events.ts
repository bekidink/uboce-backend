import { Inject, Injectable } from '@nestjs/common';
import { emitEvent, EventConsumer, REDIS } from '@uboce/common';
import type { Redis } from 'ioredis';

import { SERVICE_NAME } from '../config.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';

/** A closed account leaves every organization; its personal (single customer) account closes too. */
@Injectable()
export class UserEvents extends EventConsumer<Prisma.TransactionClient> {
  constructor(@Inject(REDIS) redis: Redis, prisma: PrismaService) {
    super(redis, prisma, SERVICE_NAME);
  }

  protected subscriptions() {
    return {
      UserAccountClosed: this.once('UserAccountClosed', async (e, tx) => {
        const userId = e.data.userId;
        const memberships = await tx.membership.findMany({ where: { userId, status: { in: ['active', 'suspended'] } } });
        for (const m of memberships) {
          await tx.membership.update({ where: { id: m.id }, data: { status: 'revoked', revokedAt: new Date() } });
          await emitEvent(tx, SERVICE_NAME, 'MembershipRevoked', m.organizationId, { organizationId: m.organizationId, membershipId: m.id, userId, revokedByUserId: userId });
        }
        const personal = await tx.organization.findUnique({ where: { personalUserId: userId } });
        if (personal && personal.status !== 'closed') {
          const closed = await tx.organization.update({ where: { id: personal.id }, data: { status: 'closed', contactEmail: null, contactPhone: null, name: 'Closed account' } });
          await emitEvent(tx, SERVICE_NAME, 'OrganizationUpdated', closed.id, {
            organizationId: closed.id,
            name: closed.name,
            type: closed.type,
            countryCode: closed.countryCode,
            status: closed.status,
            verificationStatus: closed.verificationStatus,
          });
        }
      }),
    };
  }
}
