// The initial job catalog (PRD v2 PLT-03). Definitions are created from this
// list on startup; administrators can change interval and enabled afterwards,
// and those changes are kept across restarts.

export interface JobSpec {
  service: string;
  job: string;
  description: string;
  intervalSeconds: number;
  timeoutSeconds?: number;
}

const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;

/** Every service with a database cleans its own event tables. */
export const SERVICES_WITH_EVENTS = [
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
];

export const JOB_CATALOG: JobSpec[] = [
  { service: 'commerce', job: 'orders.expire-unconfirmed', description: 'Cancel orders the seller never confirmed and release their stock', intervalSeconds: 15 * MIN },
  { service: 'commerce', job: 'orders.expire-uncollected', description: 'Mark pickups past their hold time as not collected', intervalSeconds: HOUR },
  { service: 'commerce', job: 'orders.close-delivered', description: 'Close delivered orders once the return window ends', intervalSeconds: 6 * HOUR },
  { service: 'finance', job: 'invoices.mark-overdue', description: 'Mark unpaid invoices overdue and send reminders', intervalSeconds: 6 * HOUR },
  { service: 'finance', job: 'payments.expire-attempts', description: 'Expire unfinished checkout attempts and tell the buyer', intervalSeconds: 15 * MIN },
  { service: 'procurement', job: 'quotations.expire', description: 'Expire quotations past their validity', intervalSeconds: HOUR },
  { service: 'procurement', job: 'rfqs.close-stale', description: 'Close RFQs nobody awarded after the award window', intervalSeconds: DAY },
  { service: 'inventory', job: 'reservations.release-stale', description: 'Release stock still held for finished or missing orders', intervalSeconds: DAY, timeoutSeconds: 300 },
  { service: 'inventory', job: 'stock.expiry-alerts', description: 'Tell sellers about batches that expire soon', intervalSeconds: DAY },
  { service: 'kyc', job: 'verification.expire', description: 'Expire individual verifications past their validity', intervalSeconds: HOUR },
  { service: 'kyb', job: 'verification.expire', description: 'Expire business verifications past their validity', intervalSeconds: HOUR },
  { service: 'document', job: 'documents.purge-abandoned', description: 'Remove uploads never completed and rejected files', intervalSeconds: DAY, timeoutSeconds: 300 },
  { service: 'identity', job: 'housekeeping.credentials', description: 'Delete spent SMS codes and sessions past any token lifetime', intervalSeconds: DAY },
  { service: 'administration', job: 'scheduler.purge-runs', description: 'Delete job run records older than 30 days', intervalSeconds: DAY },
  ...SERVICES_WITH_EVENTS.map((service) => ({
    service,
    job: 'housekeeping.events',
    description: 'Delete processed inbox records and old published outbox events',
    intervalSeconds: DAY,
    timeoutSeconds: 600,
  })),
];

export const jobName = (spec: Pick<JobSpec, 'service' | 'job'>) => `${spec.service}:${spec.job}`;
