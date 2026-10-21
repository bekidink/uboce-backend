// Scaffolds a new service with the house conventions:
//   node scripts/new-service.mjs <name> <port> "<PRD id and title>"
// Creates package.json, tsconfig, Nest/Prisma config, a schema with the
// standard outbox + inbox models, config, PrismaService, main and app module.
// Then: add domain models, `pnpm install`, `pnpm infra:db`, `pnpm setup`,
// and `pnpm --filter @uboce/<name> prisma:migrate:dev --name init`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [name, port, title] = process.argv.slice(2);
if (!name || !/^[a-z]+$/.test(name) || !port || !title) {
  console.error('usage: node scripts/new-service.mjs <name> <port> "<PRD id and title>"');
  process.exit(1);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, 'services', name);
if (existsSync(dir)) {
  console.error(`services/${name} already exists`);
  process.exit(1);
}
const template = join(root, 'services', 'organization');
const write = (path, content) => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const copy = (path) => write(path, readFileSync(join(template, path), 'utf8'));

const pkg = JSON.parse(readFileSync(join(template, 'package.json'), 'utf8'));
pkg.name = `@uboce/${name}`;
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
for (const file of ['tsconfig.json', 'tsconfig.build.json', 'nest-cli.json', 'prisma.config.ts', 'src/prisma.service.ts']) copy(file);

const pascal = name[0].toUpperCase() + name.slice(1);
write(
  'prisma/schema.prisma',
  `// ${title}

generator client {
  provider            = "prisma-client"
  output              = "../src/generated/prisma"
  moduleFormat        = "esm"
  importFileExtension = "js"
}

datasource db {
  provider = "postgresql"
}

/// Transactional outbox (PRD 8.3).
model OutboxEvent {
  id          String    @id @db.Uuid
  eventType   String    @map("event_type")
  payload     Json
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  publishedAt DateTime? @map("published_at") @db.Timestamptz(3)
  attempts    Int       @default(0)
  lastError   String?   @map("last_error")

  @@index([publishedAt, createdAt])
  @@map("outbox_events")
}

/// Inbox for idempotent event consumption.
model ProcessedEvent {
  eventId     String   @id @map("event_id") @db.Uuid
  eventType   String   @map("event_type")
  processedAt DateTime @default(now()) @map("processed_at") @db.Timestamptz(3)

  @@map("processed_events")
}
`,
);

write(
  'src/config.ts',
  `import { baseEnvSchema, internalCallsEnvSchema, loadEnv } from '@uboce/common';

export const SERVICE_NAME = '${name}-service';

export const env = loadEnv(baseEnvSchema.merge(internalCallsEnvSchema));
`,
);

write(
  'src/main.ts',
  `import 'reflect-metadata';

import { bootstrapService } from '@uboce/common';

import { AppModule } from './app.module.js';
import { env } from './config.js';

await bootstrapService(AppModule, {
  port: env.PORT,
  title: 'UBOCE ${pascal} Service',
  description: '${title}',
});
`,
);

write(
  'src/app.module.ts',
  `import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [],
  providers: [OutboxRelayHost(PrismaService)],
})
export class AppModule {}
`,
);

const example = readFileSync(join(template, '.env.example'), 'utf8')
  .split('\n')
  .filter((line) => !/^(APP_BASE_URL|INVITATION_TTL_DAYS)=/.test(line))
  .join('\n')
  .replaceAll('organization_svc:organization_dev', `${name}_svc:${name}_dev`)
  .replace('/organization\n', `/${name}\n`)
  .replace(/^PORT=.*$/m, `PORT=${port}`)
  .replace(/^SERVICE_CLIENT_ID=.*$/m, `SERVICE_CLIENT_ID=${name}`);
write('.env.example', example.replace(/\n+$/, '\n'));

console.log(`created services/${name} on port ${port}`);
