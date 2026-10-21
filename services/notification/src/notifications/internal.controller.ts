import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Internal } from '@uboce/common';
import { IsIn, IsObject, IsOptional, IsString, IsUUID, Length } from 'class-validator';

import { NotificationsService } from './notifications.service.js';

class SendMessageDto {
  @IsIn(['email', 'sms'])
  channel: 'email' | 'sms';

  @IsString()
  @Length(3, 254)
  to: string;

  @IsString()
  @Length(1, 64)
  template: string;

  @IsIn(['en', 'am'])
  locale: string;

  @IsObject()
  vars: Record<string, string>;

  @IsOptional()
  @IsUUID()
  userId?: string;
}

@ApiExcludeController()
@Controller('internal/messages')
export class InternalMessagesController {
  constructor(private readonly notifications: NotificationsService) {}

  /** Immediate email/SMS for messages with one-time links (reset, verification, invitations). */
  @Internal('identity', 'organization')
  @Post()
  @HttpCode(200)
  send(@Body() dto: SendMessageDto) {
    return this.notifications.sendMessage(dto);
  }
}
