import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import {
  type ActingOrganization,
  ActingOrg,
  ActsForOrganization,
  type AuthUser,
  CurrentUser,
  Internal,
  IsDecimalString,
  PaginationQueryDto,
} from '@uboce/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, Length, ValidateNested } from 'class-validator';

import { ShipmentsService } from './shipments.service.js';

class ShipmentItemDto {
  @IsUUID()
  orderLineId: string;

  @IsDecimalString('25')
  quantity: string;
}

class CreateShipmentDto {
  @IsUUID()
  orderId: string;

  /** Stock is issued from here on dispatch (drawing down the order's reservation). */
  @IsOptional()
  @IsUUID()
  originWarehouseId?: string;

  @IsOptional()
  @IsString()
  @Length(2, 300)
  destination?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  carrierName?: string;

  @IsOptional()
  @IsString()
  @Length(3, 100)
  trackingNumber?: string;

  @IsOptional()
  @IsDateString()
  expectedDeliveryAt?: string;

  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ShipmentItemDto)
  items: ShipmentItemDto[];
}

class TrackDto {
  @IsIn(['in_transit', 'failed', 'returned'])
  status: 'in_transit' | 'failed' | 'returned';

  @IsOptional()
  @IsString()
  @Length(1, 200)
  location?: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  note?: string;
}

class DeliveredItemDto {
  @IsUUID()
  orderLineId: string;

  @IsDecimalString('25')
  deliveredQuantity: string;
}

class ConfirmDeliveryDto {
  @IsString()
  @Length(2, 150)
  recipientName: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes?: string;

  /** Proof of delivery (signed note, photos) uploaded through the Document service. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  documentIds?: string[];

  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DeliveredItemDto)
  items: DeliveredItemDto[];
}

class ExceptionDto {
  @IsIn(['damaged', 'short', 'refused', 'lost', 'delayed', 'other'])
  type: string;

  @IsString()
  @Length(3, 1000)
  description: string;
}

class ListDto extends PaginationQueryDto {
  /** `outbound`: shipments you send. `inbound`: shipments you receive. */
  @IsIn(['outbound', 'inbound'])
  direction: 'outbound' | 'inbound' = 'outbound';
}

class CarrierEventDto {
  @IsString()
  @Length(2, 50)
  provider: string;

  @IsString()
  @Length(1, 200)
  externalEventId: string;

  @IsString()
  @Length(3, 100)
  trackingNumber: string;

  @IsIn(['in_transit', 'delivered', 'failed', 'returned'])
  status: 'in_transit' | 'delivered' | 'failed' | 'returned';

  @IsOptional()
  @IsString()
  @Length(1, 200)
  location?: string;

  @IsDateString()
  occurredAt: string;
}

const Id = () => Param('shipmentId', new ParseUUIDPipe());

@ApiTags('shipments')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('shipments')
export class ShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Post()
  create(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: CreateShipmentDto) {
    return this.shipments.create(org, user.userId, dto);
  }

  @Get()
  list(@ActingOrg() org: ActingOrganization, @Query() query: ListDto) {
    return this.shipments.list(org, query.direction === 'outbound' ? 'shipper' : 'consignee', query);
  }

  @Get(':shipmentId')
  get(@ActingOrg() org: ActingOrganization, @Id() id: string) {
    return this.shipments.get(org, id);
  }

  @Post(':shipmentId/dispatch')
  dispatch(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string) {
    return this.shipments.dispatch(org, user.userId, id);
  }

  @Post(':shipmentId/tracking')
  track(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string, @Body() dto: TrackDto) {
    return this.shipments.track(org, user.userId, id, dto.status, dto.location, dto.note);
  }

  /** The receiving organization confirms what arrived. */
  @Post(':shipmentId/confirm-delivery')
  confirm(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string, @Body() dto: ConfirmDeliveryDto) {
    return this.shipments.confirmDelivery(org, user.userId, id, dto);
  }

  @Post(':shipmentId/exceptions')
  exception(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string, @Body() dto: ExceptionDto) {
    return this.shipments.reportException(org, user.userId, id, dto.type, dto.description);
  }
}

@ApiExcludeController()
@Controller('internal/tracking-events')
export class InternalTrackingController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Internal('integration')
  @Post()
  @HttpCode(200)
  carrier(@Body() dto: CarrierEventDto) {
    return this.shipments.carrierEvent(dto);
  }
}
