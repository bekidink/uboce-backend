import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsEnum, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

import { MembershipRole, OrganizationType } from '../generated/prisma/enums.js';

const COUNTRY = /^[A-Z]{2}$/;

export class CreateOrganizationDto {
  @IsString()
  @Length(2, 150)
  name: string;

  @IsOptional()
  @IsString()
  @Length(2, 200)
  legalName?: string;

  @ApiProperty({ enum: OrganizationType })
  @IsEnum(OrganizationType)
  type: OrganizationType;

  /** ISO 3166-1 alpha-2. Defaults to ET. */
  @IsOptional()
  @Matches(COUNTRY, { message: 'countryCode must be an ISO 3166-1 alpha-2 code, e.g. ET' })
  countryCode?: string;
}

export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @Length(2, 150)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(2, 200)
  legalName?: string;
}

export class AddMemberDto {
  /** Identity user ID. */
  @IsUUID()
  userId: string;

  @ApiProperty({ enum: MembershipRole })
  @IsEnum(MembershipRole)
  role: MembershipRole;
}

export class UpdateMemberDto {
  @ApiProperty({ enum: MembershipRole })
  @IsEnum(MembershipRole)
  role: MembershipRole;
}

export class CreateBranchDto {
  @IsString()
  @Length(2, 150)
  name: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  region?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  city?: string;

  @IsOptional()
  @IsString()
  @Length(1, 300)
  addressLine?: string;

  @ApiPropertyOptional({ default: 'ET' })
  @IsOptional()
  @Matches(COUNTRY)
  countryCode?: string;
}

export class DirectoryQueryDto {
  @ApiProperty({ description: 'Comma-separated organization IDs (up to 100)', example: 'id1,id2' })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').map((id) => id.trim()).filter(Boolean) : value))
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  ids: string[];
}
