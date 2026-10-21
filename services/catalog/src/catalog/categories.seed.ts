import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import { PrismaService } from '../prisma.service.js';

interface SeedCategory {
  slug: string;
  name: string;
  parent?: string;
  requiredAttributes?: string[];
}

// Starting taxonomy for the Ethiopian pilot. Managed in code until a platform
// admin UI exists; changes here are applied on startup (idempotently).
export const CATEGORIES: SeedCategory[] = [
  { slug: 'agriculture', name: 'Agriculture' },
  { slug: 'coffee', name: 'Coffee', parent: 'agriculture', requiredAttributes: ['origin', 'grade', 'process'] },
  { slug: 'teff', name: 'Teff', parent: 'agriculture', requiredAttributes: ['variety'] },
  { slug: 'sesame', name: 'Sesame', parent: 'agriculture', requiredAttributes: ['grade'] },
  { slug: 'pulses', name: 'Pulses & legumes', parent: 'agriculture', requiredAttributes: ['type'] },
  { slug: 'manufacturing', name: 'Manufacturing' },
  { slug: 'textiles', name: 'Textiles & garments', parent: 'manufacturing', requiredAttributes: ['material'] },
  { slug: 'food-processing', name: 'Processed food', parent: 'manufacturing' },
  { slug: 'construction', name: 'Construction materials' },
  { slug: 'cement', name: 'Cement', parent: 'construction', requiredAttributes: ['grade'] },
  { slug: 'packaging', name: 'Packaging' },
  { slug: 'general', name: 'General goods' },
];

@Injectable()
export class CategorySeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(CategorySeeder.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap() {
    // Parents are listed before children, so one pass is enough.
    for (const c of CATEGORIES) {
      const parentId = c.parent ? (await this.prisma.category.findUnique({ where: { slug: c.parent } }))?.id : null;
      await this.prisma.category.upsert({
        where: { slug: c.slug },
        update: { name: c.name, parentId, requiredAttributes: c.requiredAttributes ?? [] },
        create: { slug: c.slug, name: c.name, parentId, requiredAttributes: c.requiredAttributes ?? [] },
      });
    }
    this.logger.log(`${CATEGORIES.length} categories in place`);
  }
}
