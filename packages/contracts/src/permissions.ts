// Fine-grained permissions (PRD addendum 2.2): module:action. Roles still decide the basics; a role
// template assigned to a member narrows them to the permissions it lists and can set an approval limit.

export const PERMISSIONS = [
  { key: 'catalog:manage', module: 'catalog', label: 'Create and edit products' },
  { key: 'prices:manage', module: 'catalog', label: 'Change prices, tiers and price lists' },
  { key: 'promotions:manage', module: 'promotions', label: 'Create promotions and coupons' },
  { key: 'rfqs:manage', module: 'procurement', label: 'Create and publish RFQs' },
  { key: 'purchase_orders:approve', module: 'procurement', label: 'Accept quotations and place orders' },
  { key: 'orders:confirm', module: 'sales', label: 'Confirm or decline sales orders' },
  { key: 'orders:cancel', module: 'sales', label: 'Cancel orders' },
  { key: 'returns:decide', module: 'returns', label: 'Approve or reject returns' },
  { key: 'stock:adjust', module: 'inventory', label: 'Adjust stock and change stock states' },
  { key: 'stock:write_off', module: 'inventory', label: 'Write off damaged stock' },
  { key: 'invoices:manage', module: 'finance', label: 'Create and issue invoices' },
  { key: 'refunds:approve', module: 'finance', label: 'Approve refunds' },
  { key: 'shipments:manage', module: 'logistics', label: 'Plan and dispatch shipments' },
  { key: 'members:manage', module: 'organization', label: 'Manage members' },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];
