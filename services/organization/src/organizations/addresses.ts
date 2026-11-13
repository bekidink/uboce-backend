import { Body, Controller, Delete, Get, HttpCode, Injectable, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { type AuthUser, badRequest, CurrentUser, notFound } from '@uboce/common';
import { IsBoolean, IsLatitude, IsLongitude, IsOptional, IsString, Length, Matches } from 'class-validator';

import { PrismaService } from '../prisma.service.js';
import { OrganizationsService } from './organizations.service.js';

const MAX_ADDRESSES = 50;

export class DeliveryAddressDto {
  @IsString()
  @Length(1, 60)
  label: string;

  @IsString()
  @Length(1, 120)
  recipientName: string;

  @Matches(/^\+?[0-9 ()-]{6,20}$/, { message: 'phone must be a phone number' })
  phone: string;

  @IsString()
  @Length(2, 200)
  line1: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  line2?: string;

  @IsString()
  @Length(1, 100)
  city: string;

  @IsOptional()
  @IsString()
  @Length(0, 100)
  region?: string;

  /** ISO 3166-1 alpha-2. Defaults to ET. */
  @IsOptional()
  @Matches(/^[A-Z]{2}$/, { message: 'countryCode must be an ISO 3166-1 alpha-2 code, e.g. ET' })
  countryCode?: string;

  @ApiPropertyOptional({ type: Number })
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({ type: Number })
  @IsOptional()
  @IsLongitude()
  longitude?: number;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  instructions?: string;

  /** Make this the address checkout suggests first. */
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateDeliveryAddressDto extends PartialType(DeliveryAddressDto) {}

@Injectable()
export class AddressesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
  ) {}

  async list(userId: string, organizationId: string) {
    await this.organizations.authorize(organizationId, userId, 'organization:read');
    return this.prisma.deliveryAddress.findMany({ where: { organizationId }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
  }

  async create(userId: string, organizationId: string, dto: DeliveryAddressDto) {
    await this.organizations.authorize(organizationId, userId, 'addresses:manage');
    const count = await this.prisma.deliveryAddress.count({ where: { organizationId } });
    if (count >= MAX_ADDRESSES) throw badRequest('too_many_addresses', `Keep at most ${MAX_ADDRESSES} addresses`);
    // The first address is the default; a new default replaces the old one.
    const isDefault = dto.isDefault ?? count === 0;
    return this.prisma.$transaction(async (tx) => {
      if (isDefault) await tx.deliveryAddress.updateMany({ where: { organizationId, isDefault: true }, data: { isDefault: false } });
      return tx.deliveryAddress.create({
        data: { ...this.data(dto), label: dto.label.trim(), recipientName: dto.recipientName.trim(), phone: dto.phone, line1: dto.line1.trim(), city: dto.city.trim(), countryCode: dto.countryCode ?? 'ET', isDefault, organizationId },
      });
    });
  }

  async update(userId: string, organizationId: string, addressId: string, dto: UpdateDeliveryAddressDto) {
    await this.organizations.authorize(organizationId, userId, 'addresses:manage');
    await this.owned(organizationId, addressId);
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) await tx.deliveryAddress.updateMany({ where: { organizationId, isDefault: true, id: { not: addressId } }, data: { isDefault: false } });
      return tx.deliveryAddress.update({ where: { id: addressId }, data: { ...this.data(dto), countryCode: dto.countryCode, isDefault: dto.isDefault } });
    });
  }

  async remove(userId: string, organizationId: string, addressId: string) {
    await this.organizations.authorize(organizationId, userId, 'addresses:manage');
    const address = await this.owned(organizationId, addressId);
    await this.prisma.$transaction(async (tx) => {
      await tx.deliveryAddress.delete({ where: { id: addressId } });
      // Keep a default while any address is left.
      if (address.isDefault) {
        const next = await tx.deliveryAddress.findFirst({ where: { organizationId }, orderBy: { createdAt: 'asc' } });
        if (next) await tx.deliveryAddress.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });
  }

  private async owned(organizationId: string, addressId: string) {
    const address = await this.prisma.deliveryAddress.findFirst({ where: { id: addressId, organizationId } });
    if (!address) throw notFound('Address');
    return address;
  }

  private data(dto: UpdateDeliveryAddressDto) {
    return {
      label: dto.label?.trim(),
      recipientName: dto.recipientName?.trim(),
      phone: dto.phone,
      line1: dto.line1?.trim(),
      line2: dto.line2 === undefined ? undefined : dto.line2.trim() || null,
      city: dto.city?.trim(),
      region: dto.region === undefined ? undefined : dto.region.trim() || null,
      latitude: dto.latitude,
      longitude: dto.longitude,
      instructions: dto.instructions === undefined ? undefined : dto.instructions.trim() || null,
    };
  }
}

const OrgId = () => Param('organizationId', new ParseUUIDPipe());
const AddressId = () => Param('addressId', new ParseUUIDPipe());

@ApiTags('organizations')
@ApiBearerAuth()
@Controller('organizations/:organizationId/addresses')
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @OrgId() organizationId: string) {
    return this.addresses.list(user.userId, organizationId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @OrgId() organizationId: string, @Body() dto: DeliveryAddressDto) {
    return this.addresses.create(user.userId, organizationId, dto);
  }

  @Patch(':addressId')
  update(@CurrentUser() user: AuthUser, @OrgId() organizationId: string, @AddressId() addressId: string, @Body() dto: UpdateDeliveryAddressDto) {
    return this.addresses.update(user.userId, organizationId, addressId, dto);
  }

  @Delete(':addressId')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @OrgId() organizationId: string, @AddressId() addressId: string) {
    await this.addresses.remove(user.userId, organizationId, addressId);
  }
}
