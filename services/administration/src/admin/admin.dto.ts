import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '@uboce/common';
import { ArrayMaxSize, IsArray, IsBoolean, IsDefined, IsEnum, IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

import { PlatformRole } from '../generated/prisma/enums.js';

/** High-impact actions always carry a reason code and a written reason (PRD 5.21). */
export class ReasonDto {
  /** Short machine-readable code, e.g. `fraud_report`, `kyb_expired`, `pilot_rollout`. */
  @Matches(/^[a-z][a-z0-9_]{2,49}$/)
  reasonCode: string;

  @IsString()
  @Length(5, 1000)
  reason: string;
}

export class GrantRoleDto extends ReasonDto {
  @IsUUID()
  userId: string;

  @ApiProperty({ enum: PlatformRole })
  @IsEnum(PlatformRole)
  role: PlatformRole;
}

export class PutSettingDto extends ReasonDto {
  /** Any JSON value. */
  @ApiProperty()
  @IsDefined()
  value: unknown;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;
}

export class PutFlagDto extends ReasonDto {
  @IsBoolean()
  enabled: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  organizationIds?: string[];

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;
}

export class OrganizationStatusDto extends ReasonDto {
  @IsIn(['active', 'suspended'])
  status: 'active' | 'suspended';
}

export class AuditQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Matches(/^[a-z_]{2,40}$/)
  targetType?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  targetId?: string;
}

export const KEY_PATTERN = /^[a-z][a-z0-9_.-]{1,99}$/;
