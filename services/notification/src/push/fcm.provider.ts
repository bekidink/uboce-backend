import { readFileSync } from 'node:fs';

import { Logger } from '@nestjs/common';
import { cert, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';

import type { PushMessage, PushProvider, PushResult } from './push.provider.js';

// FCM accepts at most 500 tokens per multicast.
const BATCH = 500;

const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/** Firebase Cloud Messaging; delivers to both Android and iOS (via APNs). */
export class FcmPushProvider implements PushProvider {
  readonly name = 'fcm';
  private readonly messaging: Messaging;

  constructor(serviceAccountPath: string) {
    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
    this.messaging = getMessaging(initializeApp({ credential: cert(serviceAccount) }, 'uboce-notification'));
  }

  async send(tokens: string[], message: PushMessage): Promise<PushResult[]> {
    const results: PushResult[] = [];
    for (let i = 0; i < tokens.length; i += BATCH) {
      const batch = tokens.slice(i, i + BATCH);
      const response = await this.messaging.sendEachForMulticast({
        tokens: batch,
        notification: { title: message.title, body: message.body },
        data: message.data,
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default' } } },
      });
      response.responses.forEach((r, index) => {
        const code = r.error?.code;
        results.push({
          token: batch[index]!,
          ok: r.success,
          invalidToken: !!code && DEAD_TOKEN_CODES.has(code),
          error: code,
        });
      });
    }
    return results;
  }
}

/** Used when Firebase isn't configured (local development): logs instead of sending. */
export class LogPushProvider implements PushProvider {
  readonly name = 'log';
  private readonly logger = new Logger('LogPushProvider');

  async send(tokens: string[], message: PushMessage): Promise<PushResult[]> {
    this.logger.log(`Push to ${tokens.length} device(s): ${message.title}`);
    return tokens.map((token) => ({ token, ok: true, invalidToken: false }));
  }
}
