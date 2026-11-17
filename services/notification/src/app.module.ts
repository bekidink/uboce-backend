import { Logger, Module } from '@nestjs/common';
import { coreModules } from '@uboce/common';

import { EMAIL_PROVIDER, LogEmailProvider, SmtpEmailProvider } from './channels/email.provider.js';
import { AfroMessageSmsProvider, HttpSmsProvider, LogSmsProvider, SMS_PROVIDER } from './channels/sms.provider.js';
import { SmsController } from './channels/sms.controller.js';
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
  controllers: [NotificationsController, InternalMessagesController, ChatController, SmsController],
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
    {
      provide: SMS_PROVIDER,
      useFactory: () => {
        const callbackUrl = env.SMS_CALLBACK_TOKEN ? `${env.PUBLIC_API_URL}/api/v1/notifications/sms/receipts/${env.SMS_PROVIDER}?token=${env.SMS_CALLBACK_TOKEN}` : undefined;
        if (env.SMS_PROVIDER === 'afromessage') {
          if (!env.SMS_API_TOKEN) throw new Error('SMS_PROVIDER=afromessage needs SMS_API_TOKEN');
          return new AfroMessageSmsProvider({ token: env.SMS_API_TOKEN, identifierId: env.SMS_IDENTIFIER_ID, sender: env.SMS_SENDER, callbackUrl, apiUrl: env.SMS_API_URL });
        }
        if (env.SMS_PROVIDER === 'http') {
          if (!env.SMS_HTTP_URL) throw new Error('SMS_PROVIDER=http needs SMS_HTTP_URL');
          return new HttpSmsProvider({ url: env.SMS_HTTP_URL, token: env.SMS_API_TOKEN, sender: env.SMS_SENDER, callbackUrl });
        }
        logger.warn('SMS_PROVIDER=log — SMS (including sign-in codes) will be logged, not sent');
        return new LogSmsProvider();
      },
    },
  ],
})
export class AppModule {}
