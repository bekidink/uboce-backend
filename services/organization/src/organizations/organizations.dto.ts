import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { BusinessModel, LocationKind, MembershipRole, OrganizationType } from '../generated/prisma/enums.js';

const COUNTRY = /^[A-Z]{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const PHONE = /^\+?[0-9 ()-]{6,20}$/;

class BusinessProfileDto {
  /** Wholesale, retail, made-to-order — several means a hybrid business. */
  @ApiPropertyOptional({ enum: BusinessModel, isArray: true })
  @IsOptional()
  @IsEnum(BusinessModel, { each: true })
  @ArrayUnique()
  businessModels?: BusinessModel[];

  @IsOptional()
  @Matches(PHONE, { message: 'contactPhone must be a phone number' })
  contactPhone?: string;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;
}

export class CreateOrganizationDto extends BusinessProfileDto {
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

export class UpdateOrganizationDto extends BusinessProfileDto {
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

export class MemberLocationsDto {
  /** Branch IDs the member may act at. Empty: the whole organization. */
  @IsUUID('all', { each: true })
  @ArrayUnique()
  @ArrayMaxSize(100)
  branchIds: string[];
}

export class UpdateMemberDto {
  @ApiProperty({ enum: MembershipRole })
  @IsEnum(MembershipRole)
  role: MembershipRole;
}

export class OperatingHoursDto {
  /** 0 = Sunday … 6 = Saturday. */
  @IsInt()
  @Min(0)
  @Max(6)
  day: number;

  @ApiProperty({ example: '08:00' })
  @Matches(TIME, { message: 'opens must be HH:mm' })
  opens: string;

  @ApiProperty({ example: '18:00' })
  @Matches(TIME, { message: 'closes must be HH:mm' })
  closes: string;
}

export class CreateBranchDto {
  @ApiPropertyOptional({ enum: LocationKind, default: LocationKind.store })
  @IsOptional()
  @IsEnum(LocationKind)
  kind?: LocationKind;

  @IsOptional()
  @Matches(PHONE, { message: 'phone must be a phone number' })
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional({ type: [OperatingHoursDto] })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => OperatingHoursDto)
  @ArrayMaxSize(21)
  operatingHours?: OperatingHoursDto[];

  /** Regions or cities this location delivers to. */
  @IsOptional()
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  @ArrayMaxSize(100)
  serviceAreas?: string[];

  /** Customers can collect orders here. */
  @IsOptional()
  @IsBoolean()
  pickupEnabled?: boolean;

  /** Orders can be fulfilled (shipped) from here. */
  @IsOptional()
  @IsBoolean()
  fulfillment?: boolean;

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

export class UpdateBranchDto extends PartialType(CreateBranchDto) {
  /** Inactive locations stay in history but take no new work. */
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class RoleTemplateDto {
  @IsString()
  @Length(2, 100)
  name: string;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  description?: string;

  /** module:action keys, e.g. purchase_orders:approve. */
  @IsString({ each: true })
  @Matches(/^[a-z_]+:[a-z_]+$/, { each: true })
  @ArrayUnique()
  @ArrayMaxSize(50)
  permissions: string[];

  @IsOptional()
  @Matches(/^\d{1,14}(\.\d{1,4})?$/)
  approvalLimit?: string | null;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  approvalCurrency?: string | null;
}

export class MemberTemplateDto {
  /** Null removes the template (the role alone decides). */
  @IsOptional()
  @IsUUID()
  roleTemplateId?: string | null;
}
