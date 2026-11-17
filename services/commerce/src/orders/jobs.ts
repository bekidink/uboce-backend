import { Injectable } from '@nestjs/common';
import { JobRegistry } from '@uboce/common';

import { OrdersService } from './orders.service.js';

/** Order timers the scheduler triggers (PRD v2 PLT-03). */
@Injectable()
export class CommerceJobs {
  constructor(jobs: JobRegistry, orders: OrdersService) {
    jobs.register('orders.expire-unconfirmed', () => orders.expireUnconfirmed());
    jobs.register('orders.expire-uncollected', () => orders.expireUncollected());
    jobs.register('orders.close-delivered', () => orders.closeDelivered());
  }
}
