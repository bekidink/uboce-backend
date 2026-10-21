import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '@uboce/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, Length } from 'class-validator';

import { DevicePlatform } from '../generated/prisma/enums.js';

export class RegisterDeviceDto {
  /** FCM registration token from the mobile app. */
  @IsString()
  @Length(20, 4096)
  token: string;

  @ApiProperty({ enum: DevicePlatform })
  @IsEnum(DevicePlatform)
  platform: DevicePlatform;
}

export class UnregisterDeviceDto {
  @IsString()
  @Length(20, 4096)
  token: string;
}

export class ListNotificationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unreadOnly = false;
}
