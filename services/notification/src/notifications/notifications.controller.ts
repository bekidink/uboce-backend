import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '@uboce/common';

import { ListNotificationsQueryDto, RegisterDeviceDto, UnregisterDeviceDto } from './notifications.dto.js';
import { NotificationsService } from './notifications.service.js';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** Call after login and whenever FCM rotates the token. */
  @Post('devices')
  @HttpCode(204)
  async registerDevice(@CurrentUser() user: AuthUser, @Body() dto: RegisterDeviceDto) {
    await this.notifications.registerDevice(user.userId, dto.token, dto.platform);
  }

  /** Call on logout, before the session is revoked. */
  @Delete('devices')
  @HttpCode(204)
  async unregisterDevice(@CurrentUser() user: AuthUser, @Body() dto: UnregisterDeviceDto) {
    await this.notifications.unregisterDevice(user.userId, dto.token);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListNotificationsQueryDto) {
    return this.notifications.list(user.userId, query, query.unreadOnly);
  }

  @Post('read-all')
  @HttpCode(204)
  async markAllRead(@CurrentUser() user: AuthUser) {
    await this.notifications.markAllRead(user.userId);
  }

  @Post(':notificationId/read')
  @HttpCode(204)
  async markRead(@CurrentUser() user: AuthUser, @Param('notificationId', new ParseUUIDPipe()) id: string) {
    await this.notifications.markRead(user.userId, id);
  }
}
