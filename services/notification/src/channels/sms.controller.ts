import { timingSafeEqual } from 'node:crypto';

import { All, Body, Controller, Get, HttpCode, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { AppError, Public, RequiresPlatformRole } from '@uboce/common';
import type { Request } from 'express';

import { env } from '../config.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { receiptStatus } from './sms.provider.js';

const tokenMatches = (given: string | undefined) => {
  const expected = env.SMS_CALLBACK_TOKEN;
  if (!expected || !given || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
};

@ApiTags('notifications')
@Controller('notifications/sms')
export class SmsController {
  constructor(private readonly notifications: NotificationsService) {}

  /**
   * Delivery receipts from the SMS gateway. Authenticated by the shared token
   * in the URL; accepts GET or POST, JSON or form fields, and the common
   * field names (message_id / messageId / id, status / state).
   */
  @Public()
  @ApiExcludeEndpoint()
  @All('receipts/:provider')
  @HttpCode(200)
  async receipt(@Param('provider') provider: string, @Query() query: Record<string, string>, @Body() body: Record<string, unknown> | undefined, @Req() req: Request) {
    if (!tokenMatches(query.token)) throw new AppError(401, 'invalid_token', 'Unknown callback');
    const fields = { ...query, ...(req.method === 'POST' && body && typeof body === 'object' ? body : {}) } as Record<string, unknown>;
    const id = String(fields.message_id ?? fields.messageId ?? fields.id ?? '');
    const status = receiptStatus(String(fields.status ?? fields.state ?? ''));
    if (!id || !status) return { ignored: true };
    return this.notifications.smsReceipt(provider, id, status);
  }

  /** This month's SMS volume, delivery receipts and estimated cost (platform administrators). */
  @ApiBearerAuth()
  @RequiresPlatformRole('platform_admin')
  @Get('usage')
  usage(@Query('month') month?: string) {
    return this.notifications.smsUsage(month && /^\d{4}-\d{2}$/.test(month) ? month : undefined);
  }
}

