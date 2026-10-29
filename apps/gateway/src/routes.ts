// Public route table: path prefix → owning service. Anything not listed is 404,
// and internal service-to-service routes are never reachable from outside.

export const SERVICES = [
  'identity',
  'organization',
  'notification',
  'catalog',
  'discovery',
  'procurement',
  'commerce',
  'inventory',
  'warehouse',
  'logistics',
  'quality',
  'agriculture',
  'manufacturing',
  'kyc',
  'kyb',
  'finance',
  'document',
  'dispute',
  'integration',
  'analytics',
  'administration',
] as const;

export type ServiceName = (typeof SERVICES)[number];

export const ROUTES: [prefix: string, service: ServiceName][] = [
  ['/api/v1/auth', 'identity'],
  ['/api/v1/organizations', 'organization'],
  ['/api/v1/invitations', 'organization'],
  ['/api/v1/notifications', 'notification'],
  ['/api/v1/conversations', 'notification'],
  ['/api/v1/catalog', 'catalog'],
  ['/api/v1/discovery', 'discovery'],
  ['/api/v1/rfqs', 'procurement'],
  ['/api/v1/quotations', 'procurement'],
  ['/api/v1/purchase-orders', 'commerce'],
  ['/api/v1/sales-orders', 'commerce'],
  ['/api/v1/returns', 'commerce'],
  ['/api/v1/promotions', 'commerce'],
  ['/api/v1/cancellation-policies', 'commerce'],
  ['/api/v1/inventory', 'inventory'],
  ['/api/v1/warehouse', 'warehouse'],
  ['/api/v1/shipments', 'logistics'],
  ['/api/v1/fleet', 'logistics'],
  ['/api/v1/quality', 'quality'],
  ['/api/v1/agriculture', 'agriculture'],
  ['/api/v1/manufacturing', 'manufacturing'],
  ['/api/v1/kyc', 'kyc'],
  ['/api/v1/kyb', 'kyb'],
  ['/api/v1/invoices', 'finance'],
  ['/api/v1/payments', 'finance'],
  ['/api/v1/refunds', 'finance'],
  ['/api/v1/settlements', 'finance'],
  ['/api/v1/documents', 'document'],
  ['/api/v1/disputes', 'dispute'],
  ['/api/v1/disputes-review', 'dispute'],
  ['/api/v1/performance', 'dispute'],
  ['/api/v1/integrations', 'integration'],
  ['/api/v1/analytics', 'analytics'],
  ['/api/v1/admin', 'administration'],
];

/** Matches whole path segments only: `/api/v1/rfqs` matches `/api/v1/rfqs/x`, not `/api/v1/rfqsx`. */
export function resolveService(path: string): ServiceName | null {
  const clean = path.split('?')[0]!.replace(/\/+$/, '');
  if (isInternalPath(clean)) return null;
  for (const [prefix, service] of ROUTES) {
    if (clean === prefix || clean.startsWith(`${prefix}/`)) return service;
  }
  return null;
}

/** Decoded and case-folded, so `/api/v1/%69nternal` and `/API/V1/Internal` don't slip through. */
export function isInternalPath(path: string) {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true; // malformed encoding: refuse
  }
  return /(^|\/)internal(\/|$)/i.test(decoded) || decoded.includes('..');
}
