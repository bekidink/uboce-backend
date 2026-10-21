import { Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';

import { NotificationsService } from './notifications.service.js';

/** Retries pushes that failed or were never sent, with backoff (see MAX_PUSH_ATTEMPTS). */
@Injectable()
export class PushRetryJob implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PushRetryJob.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(private readonly notifications: NotificationsService) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      this.running ??= this.notifications
        .retryDuePushes()
        .then((n) => n > 0 && this.logger.log(`Retried ${n} push notification(s)`))
        .catch((error) => this.logger.error(`Push retry run failed: ${error}`))
        .finally(() => (this.running = null));
    }, 30_000);
  }

  async beforeApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
