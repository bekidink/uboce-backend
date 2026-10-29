import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { FinanceEvents } from './invoices/finance-events.js';
import { InternalPaymentsController, InvoicesController } from './invoices/invoices.controller.js';
import { InvoicesService } from './invoices/invoices.service.js';
import { PaymentsController, InternalRefundsController } from './payments/payments.controller.js';
import { PaymentsService } from './payments/payments.service.js';
import { PaymentProviders } from './payments/providers.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [InvoicesController, InternalPaymentsController, PaymentsController, InternalRefundsController],
  providers: [PaymentsService, PaymentProviders, InvoicesService, FinanceEvents, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
