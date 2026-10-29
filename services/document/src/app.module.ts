import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { DocumentsController, InternalDocumentsController, PublicImagesController } from './documents/documents.controller.js';
import { DocumentsService } from './documents/documents.service.js';
import { Storage } from './documents/storage.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [PublicImagesController, DocumentsController, InternalDocumentsController],
  providers: [DocumentsService, Storage, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
