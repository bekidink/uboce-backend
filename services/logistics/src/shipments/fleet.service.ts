import { Injectable } from '@nestjs/common';
import { type ActingOrganization, AppError, badRequest, conflict, notFound, type PaginationQueryDto, requireRole, skipTake, toPage } from '@uboce/common';

import { Prisma } from '../generated/prisma/client.js';
import type { ShipmentStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma.service.js';
import { include, SHIPPER_ROLES, ShipmentsService } from './shipments.service.js';

const FLEET_ROLES = ['owner', 'admin', 'logistics_operator'];
const OPEN = ['assigned', 'accepted'] as const;

const taken = (what: string) => (error: unknown) => {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw conflict('duplicate', `That ${what} is already registered`);
  throw error;
};

/**
 * Carriers, vehicles and drivers (PRD addendum 2.8). Drivers sign in as members with
 * the "driver" role and only ever see the shipments assigned to them.
 */
@Injectable()
export class FleetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
  ) {}

  // ---- Registry --------------------------------------------------------------------------

  async fleet(org: ActingOrganization) {
    requireRole(org, [...FLEET_ROLES, ...SHIPPER_ROLES], 'view the fleet');
    const organizationId = org.organization.id;
    const [carriers, vehicles, drivers] = await Promise.all([
      this.prisma.carrier.findMany({ where: { organizationId }, orderBy: { name: 'asc' } }),
      this.prisma.vehicle.findMany({ where: { organizationId }, orderBy: { plateNumber: 'asc' } }),
      this.prisma.driver.findMany({ where: { organizationId }, orderBy: { name: 'asc' } }),
    ]);
    return { carriers, vehicles, drivers };
  }

  addCarrier(org: ActingOrganization, dto: { name: string; kind: string; phone?: string; trackingProvider?: string; carrierOrganizationId?: string }) {
    requireRole(org, FLEET_ROLES, 'manage carriers');
    return this.prisma.carrier.create({ data: { ...dto, name: dto.name.trim(), organizationId: org.organization.id } });
  }

  addVehicle(org: ActingOrganization, dto: { plateNumber: string; type: string; capacityKg?: string }) {
    requireRole(org, FLEET_ROLES, 'manage vehicles');
    return this.prisma.vehicle.create({ data: { ...dto, plateNumber: dto.plateNumber.trim().toUpperCase(), organizationId: org.organization.id } }).catch(taken('plate number'));
  }

  addDriver(org: ActingOrganization, dto: { name: string; phone: string; licenseNumber?: string; userId?: string }) {
    requireRole(org, FLEET_ROLES, 'manage drivers');
    return this.prisma.driver.create({ data: { ...dto, name: dto.name.trim(), organizationId: org.organization.id } }).catch(taken('driver account'));
  }

  async setActive(org: ActingOrganization, kind: 'carrier' | 'vehicle' | 'driver', id: string, active: boolean) {
    requireRole(org, FLEET_ROLES, 'manage the fleet');
    const where = { id, organizationId: org.organization.id };
    const delegate = { carrier: this.prisma.carrier, vehicle: this.prisma.vehicle, driver: this.prisma.driver }[kind] as unknown as {
      updateMany(args: { where: typeof where; data: { active: boolean } }): Promise<{ count: number }>;
    };
    const { count } = await delegate.updateMany({ where, data: { active } });
    if (!count) throw notFound(kind[0]!.toUpperCase() + kind.slice(1));
    return { id, active };
  }

  // ---- Assignments ----------------------------------------------------------------------------

  /** Assigns a driver (and vehicle) to a shipment that hasn't left yet; a previous open assignment is replaced. */
  async assign(org: ActingOrganization, userId: string, shipmentId: string, dto: { driverId: string; vehicleId?: string }) {
    requireRole(org, [...FLEET_ROLES, 'warehouse_operator'], 'assign drivers');
    const shipment = await this.shipments.visible(org, shipmentId);
    const asCarrier = shipment.carrierOrganizationId === org.organization.id && shipment.shipperOrganizationId !== org.organization.id;
    if (!asCarrier && shipment.shipperOrganizationId !== org.organization.id) throw notFound('Shipment');
    if (asCarrier && shipment.carrierStatus !== 'accepted') throw conflict('not_accepted', 'Accept the shipment first');
    if (!['created', 'assigned', 'ready_for_pickup', 'dispatched'].includes(shipment.status)) throw conflict('invalid_state', `A ${shipment.status} shipment can't be reassigned`);
    const driver = await this.prisma.driver.findFirst({ where: { id: dto.driverId, organizationId: org.organization.id, active: true } });
    if (!driver) throw badRequest('unknown_driver', 'Driver not found or inactive');
    if (dto.vehicleId && !(await this.prisma.vehicle.findFirst({ where: { id: dto.vehicleId, organizationId: org.organization.id, active: true } }))) {
      throw badRequest('unknown_vehicle', 'Vehicle not found or inactive');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.driverAssignment.updateMany({ where: { shipmentId, status: { in: [...OPEN] } }, data: { status: 'cancelled' } });
      await tx.driverAssignment.create({ data: { shipmentId, driverId: driver.id, vehicleId: dto.vehicleId ?? null, assignedByUserId: userId } });
    });
    if (shipment.status === 'created') return this.shipments.applyStatus(shipment, 'assigned', `user:${userId}`, new Date(), { note: `assigned to ${driver.name}` });
    return this.prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include });
  }

  // ---- Driver-scoped access -------------------------------------------------------------------

  /** The signed-in driver's open assignments in this organization. */
  async myAssignments(org: ActingOrganization, userId: string, query: PaginationQueryDto) {
    const driver = await this.driverFor(org, userId);
    const where: Prisma.DriverAssignmentWhereInput = { driverId: driver.id, status: { in: [...OPEN] } };
    const [items, total] = await Promise.all([
      this.prisma.driverAssignment.findMany({
        where,
        include: { vehicle: true, shipment: { include: { items: true, orders: true, packages: true } } },
        orderBy: { assignedAt: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.driverAssignment.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async accept(org: ActingOrganization, userId: string, assignmentId: string) {
    const driver = await this.driverFor(org, userId);
    const { count } = await this.prisma.driverAssignment.updateMany({ where: { id: assignmentId, driverId: driver.id, status: 'assigned' }, data: { status: 'accepted' } });
    if (!count) throw notFound('Assignment');
    return this.prisma.driverAssignment.findUniqueOrThrow({ where: { id: assignmentId }, include: { shipment: true, vehicle: true } });
  }

  /** Picked up, in transit, delayed or failed — only on a shipment assigned to this driver. */
  async driverUpdate(org: ActingOrganization, userId: string, shipmentId: string, status: ShipmentStatus, location?: string, note?: string) {
    const driver = await this.driverFor(org, userId);
    const assignment = await this.prisma.driverAssignment.findFirst({ where: { shipmentId, driverId: driver.id, status: { in: [...OPEN] } } });
    if (!assignment) throw notFound('Shipment');
    const shipment = await this.prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include });
    return this.shipments.driverUpdate(shipment, userId, status, location, note);
  }

  private async driverFor(org: ActingOrganization, userId: string) {
    if (!['driver', 'logistics_operator', 'owner', 'admin'].includes(org.role)) throw new AppError(403, 'forbidden', 'Only drivers have assignments');
    const driver = await this.prisma.driver.findFirst({ where: { organizationId: org.organization.id, userId, active: true } });
    if (!driver) throw notFound('Driver profile');
    return driver;
  }
}
