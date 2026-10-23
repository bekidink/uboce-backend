/**
 * A peer service's base URL. Hosting platforms often hand out internal
 * addresses as `host:port` (e.g. Render's `fromService: hostport`); those get
 * `http://`, since service-to-service traffic stays on the private network.
 */
export function serviceUrl(value: string): string;
export function serviceUrl(value: string | undefined): string | undefined;
export function serviceUrl(value: string | undefined) {
  if (!value) return value;
  const trimmed = value.trim().replace(/\/+$/, '');
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}
