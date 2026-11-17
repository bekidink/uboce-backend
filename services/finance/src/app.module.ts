import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { CollectionsController } from './collections/collections.controller.js';
import { CollectionsService } from './collections/collections.service.js';
import { FinanceJobs } from './collections/jobs.js';
import { env, SERVICE_NAME } from './config.js';
import { FinanceEvents } from './invoices/finance-events.js';
import { InternalPaymentsController, InvoicesController } from './invoices/invoices.controller.js';
import { InvoicesService } from './invoices/invoices.service.js';
import { PaymentsController, InternalRefundsController } from './payments/payments.controller.js';
import { PaymentsService } from './payments/payments.service.js';
import { PaymentProviders } from './payments/providers.js';
import { PrismaModule, PrismaService } from './prisma.service.js';
import { InternalTaxController, TaxAdminController, TaxController } from './tax/tax.controller.js';
import { TaxService } from './tax/tax.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [InvoicesController, InternalPaymentsController, PaymentsController, InternalRefundsController, CollectionsController, TaxController, TaxAdminController, InternalTaxController],
  providers: [PaymentsService, PaymentProviders, InvoicesService, CollectionsService, TaxService, FinanceJobs, FinanceEvents, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
