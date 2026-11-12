import { Injectable } from '@nestjs/common';
import { type ActingOrganization, AppError, badRequest, locationScope, requireLocation, WarehousesClient } from '@uboce/common';

/**
 * Location-scoped staff (PRD addendum 2.2) see and change stock only in warehouses at their
 * locations (or organization-wide ones). Members without location assignments cover everything.
 */
@Injectable()
export class WarehouseScope {
  constructor(private readonly warehouses: WarehousesClient) {}

  /** Warehouse IDs the member may use, or null for all of the organization's. */
  async allowed(org: ActingOrganization): Promise<string[] | null> {
    const branches = locationScope(org);
    if (!branches) return null;
    return (await this.warehouses.forLocations(org.organization.id, branches)).map((w) => w.id);
  }

  /** The warehouse filter for a list query, narrowed to `warehouseId` when the caller asks for one. */
  async filter(org: ActingOrganization, warehouseId?: string): Promise<string | { in: string[] } | undefined> {
    const allowed = await this.allowed(org);
    if (!allowed) return warehouseId;
    if (warehouseId) {
      if (!allowed.includes(warehouseId)) throw new AppError(403, 'location_forbidden', 'You are not assigned to the location of this warehouse');
      return warehouseId;
    }
    return { in: allowed };
  }

  /** The warehouse must belong to the organization and to one of the member's locations. */
  async require(org: ActingOrganization, warehouseId: string, action: string) {
    const warehouse = await this.warehouses.get(warehouseId);
    if (!warehouse || warehouse.organizationId !== org.organization.id) throw badRequest('unknown_warehouse', 'Warehouse not found in your organization');
    requireLocation(org, warehouse.branchId, action);
    return warehouse;
  }
}
