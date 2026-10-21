import { Inject, Injectable } from '@nestjs/common';
import { emitEvent, EventConsumer, REDIS } from '@uboce/common';
import type { Redis } from 'ioredis';

import { SERVICE_NAME } from '../config.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { VerificationStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma.service.js';

/** KYB outcome → the organization's verification status (never set by clients). */
const STATUS_FOR: Record<string, VerificationStatus> = {
  submitted: 'pending',
  needs_information: 'pending',
  approved: 'verified',
  rejected: 'rejected',
  suspended: 'suspended',
  expired: 'expired',
};

@Injectable()
export class VerificationEvents extends EventConsumer<Prisma.TransactionClient> {
  constructor(@Inject(REDIS) redis: Redis, prisma: PrismaService) {
    super(redis, prisma, SERVICE_NAME);
  }

  protected subscriptions() {
    return {
      KybVerificationDecided: this.once('KybVerificationDecided', async (e, tx) => {
        const verificationStatus = STATUS_FOR[e.data.decision];
        if (!verificationStatus) return;
        const organization = await tx.organization.update({ where: { id: e.data.subjectId }, data: { verificationStatus } }).catch(() => null);
        if (!organization) return;
        await emitEvent(tx, SERVICE_NAME, 'OrganizationUpdated', organization.id, {
          organizationId: organization.id,
          name: organization.name,
          type: organization.type,
          countryCode: organization.countryCode,
          status: organization.status,
          verificationStatus: organization.verificationStatus,
        });
      }),
    };
  }
}
