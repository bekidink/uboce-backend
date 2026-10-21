import { existsSync } from 'node:fs';

import { defineConfig } from 'prisma/config';

if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // The placeholder lets `prisma generate` run without a database (Docker builds, CI).
  datasource: { url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/unset' },
});
