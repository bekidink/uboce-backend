/**
 * Connection options for @prisma/adapter-pg, from a service's DATABASE_URL.
 *
 * Locally every service has its own database, so tables live in `public`. On a
 * shared server (e.g. one Supabase database) each service has its own schema
 * instead, named by `?schema=` in the URL: Prisma qualifies its queries with it,
 * and the service's role has it as its search_path for raw SQL.
 *
 * DATABASE_POOL_MAX caps connections per service process (keep it small behind a
 * connection pooler with a shared limit).
 */
export function pgOptions(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const schema = url.searchParams.get('schema') ?? undefined;
  url.searchParams.delete('schema');
  const max = Number(process.env.DATABASE_POOL_MAX ?? 10);
  return {
    pool: { connectionString: url.toString(), max: Number.isFinite(max) && max > 0 ? max : 10 },
    adapter: schema ? { schema } : undefined,
  };
}

/** The schema this service's tables live in (`?schema=` in DATABASE_URL, else `public`). */
export function dbSchema(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? '').searchParams.get('schema') ?? 'public';
  } catch {
    return 'public';
  }
}

/**
 * A table name qualified with the service's schema, for raw SQL. Prisma's own
 * queries are qualified already; raw SQL must not rely on search_path, which a
 * transaction-mode pooler doesn't keep per service.
 */
export const qualified = (table: string) => `"${dbSchema().replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"`;
