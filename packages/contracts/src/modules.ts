// Platform module registry (PRD addendum 2.10). Core modules are always on; the others
// follow each organization's entitlement, falling back to `defaultEnabled`.

export interface ModuleDefinition {
  key: string;
  name: string;
  description: string;
  core: boolean;
  defaultEnabled: boolean;
  /** When set, the module is on by default only for these business types. */
  defaultTypes?: readonly string[];
}

/** Organization (business) types; admins decide which modules each type gets. */
export const BUSINESS_TYPES = ['business', 'cooperative', 'farm', 'manufacturer', 'wholesaler', 'distributor', 'warehouse', 'logistics_provider', 'other'] as const;

export const MODULES = [
  { key: 'catalog', name: 'Catalog', description: 'Products, variants, images, price tiers and price lists', core: true, defaultEnabled: true },
  { key: 'procurement', name: 'Procurement', description: 'RFQs, quotations and purchase orders', core: true, defaultEnabled: true },
  { key: 'sales', name: 'Sales', description: 'Sales orders, direct orders and fulfilment', core: true, defaultEnabled: true },
  { key: 'finance', name: 'Invoices & payments', description: 'Invoices, online payments, refunds and settlements', core: true, defaultEnabled: true },
  { key: 'inventory', name: 'Inventory', description: 'Stock ledger, reservations, states and cycle counts', core: false, defaultEnabled: true },
  { key: 'warehouse', name: 'Warehouses', description: 'Warehouses, bins, receiving and transfers', core: false, defaultEnabled: true },
  { key: 'logistics', name: 'Logistics', description: 'Shipments, tracking and proof of delivery', core: false, defaultEnabled: true },
  { key: 'fleet', name: 'Fleet & drivers', description: 'Carriers, vehicles, drivers and assignments', core: false, defaultEnabled: false, defaultTypes: ['logistics_provider', 'distributor'] },
  { key: 'quality', name: 'Quality', description: 'Inspections, specifications, certifications and claims', core: false, defaultEnabled: true },
  { key: 'agriculture', name: 'Agriculture', description: 'Farms, seasons, harvests and produce lots', core: false, defaultEnabled: true, defaultTypes: ['cooperative', 'farm', 'warehouse', 'other'] },
  { key: 'manufacturing', name: 'Manufacturing', description: 'Recipes, production orders and batches', core: false, defaultEnabled: true, defaultTypes: ['manufacturer', 'other'] },
  { key: 'promotions', name: 'Promotions', description: 'Discounts, coupons and automatic offers', core: false, defaultEnabled: true },
  { key: 'returns', name: 'Returns', description: 'Return requests and cancellation policies', core: false, defaultEnabled: true },
  { key: 'chat', name: 'Messages', description: 'Chat with buyers, suppliers and partners', core: false, defaultEnabled: true },
  { key: 'analytics', name: 'Reports', description: 'Dashboards, store and location reports', core: false, defaultEnabled: true },
  { key: 'report_summaries', name: 'Report summaries', description: 'AI store activity and business reports citing their figures', core: false, defaultEnabled: true },
] as const satisfies readonly ModuleDefinition[];

/** A module's default for a business type, before any admin setting. */
export function moduleDefault(m: ModuleDefinition, type: string | null | undefined) {
  if (m.core) return true;
  if (m.defaultTypes) return Boolean(type && m.defaultTypes.includes(type));
  return m.defaultEnabled;
}

export type ModuleKey = (typeof MODULES)[number]['key'];

/** Admin: GET /internal/entitlements/:organizationId */
export interface InternalEntitlements {
  organizationId: string;
  modules: Record<string, boolean>;
}
