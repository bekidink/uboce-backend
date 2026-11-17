import { Injectable } from '@nestjs/common';
import { JobRegistry } from '@uboce/common';

import { PrismaService } from '../prisma.service.js';
import { Storage } from './storage.js';

const DAY = 86_400_000;

/** Document housekeeping triggered by the scheduler (PRD v2 PLT-03, PLT-06). */
@Injectable()
export class DocumentJobs {
  constructor(
    jobs: JobRegistry,
    private readonly prisma: PrismaService,
    private readonly storage: Storage,
  ) {
    jobs.register('documents.purge-abandoned', () => this.purgeAbandoned());
  }

  /**
   * Uploads never completed within a day, and files rejected by the content
   * checks a week ago, are removed from storage. Retention periods and legal
   * holds only protect available documents, so they don't apply here.
   */
  async purgeAbandoned(now = new Date()) {
    const stale = await this.prisma.document.findMany({
      where: {
        legalHold: false,
        OR: [
          { status: 'pending_upload', createdAt: { lt: new Date(now.getTime() - DAY) } },
          { status: 'rejected', updatedAt: { lt: new Date(now.getTime() - 7 * DAY) }, deletedAt: null },
        ],
      },
      select: { id: true, storageKey: true, status: true },
      take: 500,
    });
    let n = 0;
    for (const d of stale) {
      await this.storage.remove(d.storageKey).catch(() => {});
      const { count } = await this.prisma.document.updateMany({ where: { id: d.id, status: d.status }, data: { status: 'deleted', deletedAt: now } });
      n += count;
    }
    return n;
  }
}
