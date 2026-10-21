// Public route table: path prefix → owning service. Anything not listed is 404,
// and internal service-to-service routes are never reachable from outside.

export type ServiceName =
  | 'identity'
  | 'organization'
  | 'notification'
  | 'catalog'
  | 'discovery'
  | 'procurement'
  | 'commerce';

export const ROUTES: [prefix: string, service: ServiceName][] = [
  ['/api/v1/auth', 'identity'],
  ['/api/v1/organizations', 'organization'],
  ['/api/v1/invitations', 'organization'],
  ['/api/v1/notifications', 'notification'],
  ['/api/v1/catalog', 'catalog'],
  ['/api/v1/discovery', 'discovery'],
  ['/api/v1/rfqs', 'procurement'],
  ['/api/v1/quotations', 'procurement'],
  ['/api/v1/purchase-orders', 'commerce'],
  ['/api/v1/sales-orders', 'commerce'],
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
