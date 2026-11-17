import { Injectable } from '@nestjs/common';
import { JobRegistry } from '@uboce/common';

import { env } from '../config.js';
import { PrismaService } from '../prisma.service.js';

const DAY = 86_400_000;

/** Identity housekeeping (PRD v2 PLT-09): spent codes and long-dead sessions. */
@Injectable()
export class IdentityJobs {
  constructor(
    jobs: JobRegistry,
    private readonly prisma: PrismaService,
  ) {
    jobs.register('housekeeping.credentials', () => this.purge());
  }

  async purge(now = new Date()) {
    const codes = await this.prisma.phoneVerification.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - DAY) } } });
    // Past any refresh token's lifetime: nothing can present them any more, and the security log keeps the history.
    const old = new Date(now.getTime() - (Math.max(30, env.REFRESH_TOKEN_TTL_DAYS) + 1) * DAY);
    const sessions = await this.prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: old } }, { revokedAt: { lt: old } }] } });
    return codes.count + sessions.count;
  }
}
