import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { FinanceEvents } from './invoices/finance-events.js';
import { InternalPaymentsController, InvoicesController } from './invoices/invoices.controller.js';
import { InvoicesService } from './invoices/invoices.service.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [InvoicesController, InternalPaymentsController],
  providers: [InvoicesService, FinanceEvents, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
