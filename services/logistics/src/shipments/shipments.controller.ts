import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import {
  type ActingOrganization,
  ActingOrg,
  ActsForOrganization,
  badRequest,
  type AuthUser,
  CurrentUser,
  Internal,
  IsDecimalString,
  PaginationQueryDto,
  RequiresModule,
} from '@uboce/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsOptional, IsString, IsUUID, Length, Matches, ValidateNested } from 'class-validator';

import { CarrierService } from './carrier.service.js';
import { FleetService } from './fleet.service.js';
import { ShipmentsService } from './shipments.service.js';

class ShipmentItemDto {
  @IsUUID()
  orderLineId: string;

  /** For consolidated shipments: the order this line belongs to (defaults to orderId). */
  @IsOptional()
  @IsUUID()
  orderId?: string;

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

  @IsOptional()
  @IsUUID()
  carrierId?: string;

  /** A logistics provider on UBOCE to carry the shipment. */
  @IsOptional()
  @IsUUID()
  carrierOrganizationId?: string;

  @IsOptional()
  @IsDateString()
  pickupWindowStart?: string;

  @IsOptional()
  @IsDateString()
  pickupWindowEnd?: string;

  /** Who pays for freight. */
  @IsOptional()
  @IsIn(['shipper', 'consignee', 'third_party'])
  freightPayer?: 'shipper' | 'consignee' | 'third_party';

  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  incoterm?: string;

  @IsOptional()
  @IsDecimalString('1500')
  freightCost?: string;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  freightCurrency?: string;

  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ShipmentItemDto)
  items: ShipmentItemDto[];
}

class TrackDto {
  @IsIn(['picked_up', 'in_transit', 'delayed', 'failed', 'returned'])
  status: 'picked_up' | 'in_transit' | 'delayed' | 'failed' | 'returned';

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
  /** `outbound`: shipments you send. `inbound`: shipments you receive. `carrier`: shipments you were asked to carry. */
  @IsIn(['outbound', 'inbound', 'carrier'])
  direction: 'outbound' | 'inbound' | 'carrier' = 'outbound';

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsUUID()
  orderId?: string;
}

class PackageDto {
  @IsString()
  @Length(1, 60)
  reference: string;

  @IsOptional()
  @IsDecimalString('25.5')
  weightKg?: string;

  @IsOptional()
  @IsDecimalString('60')
  lengthCm?: string;

  @IsOptional()
  @IsDecimalString('40')
  widthCm?: string;

  @IsOptional()
  @IsDecimalString('40')
  heightCm?: string;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  contents?: string;
}

class PackagesDto {
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PackageDto)
  packages: PackageDto[];
}

class CarrierOrgDto {
  /** Null takes the shipment back. */
  @IsOptional()
  @IsUUID()
  carrierOrganizationId?: string | null;
}

class CarrierResponseDto {
  @IsIn(['accept', 'decline'])
  decision: 'accept' | 'decline';

  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;
}

class AssignDto {
  @IsUUID()
  driverId: string;

  @IsOptional()
  @IsUUID()
  vehicleId?: string;
}

class CarrierDto {
  @IsString()
  @Length(2, 150)
  name: string;

  @IsIn(['own_fleet', 'third_party'])
  kind: string;

  @IsOptional()
  @IsString()
  @Length(6, 30)
  phone?: string;

  /** Integration provider name for its tracking callbacks. */
  @IsOptional()
  @IsString()
  @Length(2, 50)
  trackingProvider?: string;

  /** The logistics provider's UBOCE organization, so shipments can be handed to it. */
  @IsOptional()
  @IsUUID()
  carrierOrganizationId?: string;
}

class VehicleDto {
  @IsString()
  @Length(2, 20)
  plateNumber: string;

  @IsIn(['truck', 'van', 'pickup', 'motorbike', 'other'])
  type: string;

  @IsOptional()
  @IsDecimalString('5000')
  capacityKg?: string;
}

class DriverDto {
  @IsString()
  @Length(2, 150)
  name: string;

  @IsString()
  @Length(6, 30)
  phone: string;

  @IsOptional()
  @IsString()
  @Length(2, 50)
  licenseNumber?: string;

  /** The driver's UBOCE account (a member with the driver role), so they can see their assignments. */
  @IsOptional()
  @IsUUID()
  userId?: string;
}

class ActiveDto {
  @IsBoolean()
  active: boolean;
}

class DriverUpdateDto {
  @IsIn(['picked_up', 'in_transit', 'delayed', 'failed'])
  status: 'picked_up' | 'in_transit' | 'delayed' | 'failed';

  @IsOptional()
  @IsString()
  @Length(1, 200)
  location?: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  note?: string;
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
@RequiresModule('logistics')
@Controller('shipments')
export class ShipmentsController {
  constructor(
    private readonly shipments: ShipmentsService,
    private readonly fleet: FleetService,
    private readonly carriers: CarrierService,
  ) {}

  /** Shipper: hand the shipment to a logistics provider (null takes it back). */
  @Put(':shipmentId/carrier')
  setCarrier(@ActingOrg() org: ActingOrganization, @Id() id: string, @Body() dto: CarrierOrgDto) {
    return this.carriers.setCarrier(org, id, dto.carrierOrganizationId ?? null);
  }

  /** Logistics provider: accept or decline carrying the shipment. */
  @Post(':shipmentId/carrier-response')
  @HttpCode(200)
  respond(@ActingOrg() org: ActingOrganization, @Id() id: string, @Body() dto: CarrierResponseDto) {
    return this.carriers.respond(org, id, dto.decision, dto.note);
  }

  @Post()
  create(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: CreateShipmentDto) {
    return this.shipments.create(org, user.userId, dto);
  }

  @Get()
  list(@ActingOrg() org: ActingOrganization, @Query() query: ListDto) {
    return this.shipments.list(org, query.direction === 'outbound' ? 'shipper' : query.direction === 'carrier' ? 'carrier' : 'consignee', query);
  }

  /** Drivers: my open assignments. */
  @Get('driver/assignments')
  myAssignments(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Query() query: PaginationQueryDto) {
    return this.fleet.myAssignments(org, user.userId, query);
  }

  @Post('driver/assignments/:assignmentId/accept')
  @HttpCode(200)
  accept(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Param('assignmentId', new ParseUUIDPipe()) id: string) {
    return this.fleet.accept(org, user.userId, id);
  }

  @Get(':shipmentId')
  get(@ActingOrg() org: ActingOrganization, @Id() id: string) {
    return this.shipments.get(org, id);
  }

  /** Packages on the shipment (replaces the list; before dispatch). */
  @Put(':shipmentId/packages')
  packages(@ActingOrg() org: ActingOrganization, @Id() id: string, @Body() dto: PackagesDto) {
    return this.shipments.setPackages(org, id, dto.packages);
  }

  @Post(':shipmentId/ready-for-pickup')
  ready(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string) {
    return this.shipments.readyForPickup(org, user.userId, id);
  }

  @Post(':shipmentId/assign')
  assign(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string, @Body() dto: AssignDto) {
    return this.fleet.assign(org, user.userId, id, dto);
  }

  /** Drivers: status updates on a shipment assigned to them. */
  @Post(':shipmentId/driver-updates')
  driverUpdate(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string, @Body() dto: DriverUpdateDto) {
    return this.fleet.driverUpdate(org, user.userId, id, dto.status, dto.location, dto.note);
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

@ApiExcludeController()
@Controller('internal/shipments')
export class InternalShipmentsController {
  constructor(private readonly carriers: CarrierService) {}

  @Internal('notification', 'dispute')
  @Get(':shipmentId')
  get(@Param('shipmentId', new ParseUUIDPipe()) id: string) {
    return this.carriers.internalGet(id);
  }
}

@ApiTags('fleet')
@ApiBearerAuth()
@ActsForOrganization()
@RequiresModule('fleet')
@Controller('fleet')
export class FleetController {
  constructor(private readonly fleet: FleetService) {}

  /** Carriers, vehicles and drivers of the acting organization. */
  @Get()
  list(@ActingOrg() org: ActingOrganization) {
    return this.fleet.fleet(org);
  }

  @Post('carriers')
  carrier(@ActingOrg() org: ActingOrganization, @Body() dto: CarrierDto) {
    return this.fleet.addCarrier(org, dto);
  }

  @Post('vehicles')
  vehicle(@ActingOrg() org: ActingOrganization, @Body() dto: VehicleDto) {
    return this.fleet.addVehicle(org, dto);
  }

  @Post('drivers')
  driver(@ActingOrg() org: ActingOrganization, @Body() dto: DriverDto) {
    return this.fleet.addDriver(org, dto);
  }

  @Post(':kind/:id/active')
  @HttpCode(200)
  active(@ActingOrg() org: ActingOrganization, @Param('kind') kind: string, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ActiveDto) {
    const map: Record<string, 'carrier' | 'vehicle' | 'driver'> = { carriers: 'carrier', vehicles: 'vehicle', drivers: 'driver' };
    if (!map[kind]) throw badRequest('unknown_kind', 'Use carriers, vehicles or drivers');
    return this.fleet.setActive(org, map[kind], id, dto.active);
  }
}
