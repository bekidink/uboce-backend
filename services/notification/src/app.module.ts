import { Logger, Module } from '@nestjs/common';
import { coreModules } from '@uboce/common';

import { EMAIL_PROVIDER, LogEmailProvider, SmtpEmailProvider } from './channels/email.provider.js';
import { LogSmsProvider, SMS_PROVIDER } from './channels/sms.provider.js';
import { env, SERVICE_NAME } from './config.js';
import { ChatController } from './chat/chat.controller.js';
import { ChatService } from './chat/chat.service.js';
import { NotificationEventHandlers } from './notifications/event-handlers.js';
import { InternalMessagesController } from './notifications/internal.controller.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { NotificationsService } from './notifications/notifications.service.js';
import { PushRetryJob } from './notifications/push-retry.job.js';
import { PrismaModule, PrismaService } from './prisma.service.js';
import { FcmPushProvider, LogPushProvider } from './push/fcm.provider.js';
import { PUSH_PROVIDER } from './push/push.provider.js';

const logger = new Logger('Channels');

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [NotificationsController, InternalMessagesController, ChatController],
  providers: [
    NotificationsService,
    ChatService,
    NotificationEventHandlers,
    PushRetryJob,
    {
      provide: PUSH_PROVIDER,
      useFactory: () => {
        if (env.FIREBASE_SERVICE_ACCOUNT_PATH) return new FcmPushProvider(env.FIREBASE_SERVICE_ACCOUNT_PATH);
        logger.warn('FIREBASE_SERVICE_ACCOUNT_PATH not set — push notifications will be logged, not sent');
        return new LogPushProvider();
      },
    },
    {
      provide: EMAIL_PROVIDER,
      useFactory: () => {
        if (env.SMTP_URL) return new SmtpEmailProvider(env.SMTP_URL, env.EMAIL_FROM);
        logger.warn('SMTP_URL not set — emails will be logged, not sent');
        return new LogEmailProvider();
      },
    },
    { provide: SMS_PROVIDER, useFactory: () => new LogSmsProvider() },
  ],
})
export class AppModule {}
