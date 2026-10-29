import { Module } from '@nestjs/common';
import { coreModules } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { AnalyticsController, AnalyticsProjector } from './metrics/analytics.js';
import { ActivityController } from './metrics/activity.js';
import { ReportTemplatesController } from './metrics/report-templates.js';
import { ReportSummaryController, ReportSummaryService } from './metrics/report-summary.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [ActivityController, ReportTemplatesController, ReportSummaryController, AnalyticsController],
  providers: [ReportSummaryService, AnalyticsProjector],
})
export class AppModule {}
