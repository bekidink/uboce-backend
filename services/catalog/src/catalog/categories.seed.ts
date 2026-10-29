import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import { PrismaService } from '../prisma.service.js';
import type { AttributeDefinition } from './publishing.js';

interface SeedCategory {
  slug: string;
  name: string;
  parent?: string;
  attributes?: AttributeDefinition[];
}

const text = (key: string, label: string, extra: Partial<AttributeDefinition> = {}): AttributeDefinition => ({ key, label, type: 'text', ...extra });
const choice = (key: string, label: string, options: string[], extra: Partial<AttributeDefinition> = {}): AttributeDefinition => ({
  key,
  label,
  type: 'enum',
  options,
  filterable: true,
  ...extra,
});
const num = (key: string, label: string, unit: string, extra: Partial<AttributeDefinition> = {}): AttributeDefinition => ({ key, label, type: 'number', unit, ...extra });
const flag = (key: string, label: string): AttributeDefinition => ({ key, label, type: 'boolean', filterable: true });
const R = { required: true };

// Platform taxonomy (sectors and their categories), with typed attributes (PRD addendum 2.3).
// Managed in code until a platform admin UI exists; applied on startup (idempotently).
export const CATEGORIES: SeedCategory[] = [
  { slug: 'agriculture', name: 'Agriculture' },
  {
    slug: 'coffee',
    name: 'Coffee',
    parent: 'agriculture',
    attributes: [
      text('origin', 'Origin', { ...R, filterable: true }),
      choice('grade', 'Grade', ['1', '2', '3', '4', '5', 'UG'], R),
      choice('process', 'Process', ['washed', 'natural', 'honey', 'anaerobic'], R),
      num('altitude_m', 'Altitude', 'm', { min: 0, max: 4000, filterable: true }),
      num('moisture_pct', 'Moisture', '%', { min: 0, max: 20 }),
      num('cup_score', 'Cup score', 'pts', { min: 0, max: 100, filterable: true }),
      flag('organic', 'Organic certified'),
    ],
  },
  {
    slug: 'teff',
    name: 'Teff',
    parent: 'agriculture',
    attributes: [choice('variety', 'Variety', ['white', 'red', 'mixed', 'flour'], R), num('purity_pct', 'Purity', '%', { min: 0, max: 100 }), flag('organic', 'Organic certified')],
  },
  {
    slug: 'sesame',
    name: 'Sesame',
    parent: 'agriculture',
    attributes: [text('grade', 'Grade', { ...R, filterable: true }), choice('type', 'Type', ['humera', 'wollega', 'gondar'], { filterable: true }), num('oil_content_pct', 'Oil content', '%', { min: 0, max: 70 })],
  },
  { slug: 'pulses', name: 'Pulses & legumes', parent: 'agriculture', attributes: [text('type', 'Type', { ...R, filterable: true }), num('moisture_pct', 'Moisture', '%', { min: 0, max: 20 })] },
  { slug: 'manufacturing', name: 'Manufacturing' },
  {
    slug: 'textiles',
    name: 'Textiles & garments',
    parent: 'manufacturing',
    attributes: [text('material', 'Material', { ...R, filterable: true }), num('gsm', 'Weight', 'g/m²', { min: 0 }), text('color', 'Colour', { filterable: true })],
  },
  { slug: 'food-processing', name: 'Processed food', parent: 'manufacturing', attributes: [num('shelf_life_days', 'Shelf life', 'days', { min: 0 }), flag('halal', 'Halal certified')] },
  { slug: 'construction', name: 'Construction materials' },
  { slug: 'cement', name: 'Cement', parent: 'construction', attributes: [choice('grade', 'Grade', ['32.5', '42.5', '52.5'], R), choice('type', 'Type', ['OPC', 'PPC'], { filterable: true })] },
  { slug: 'packaging', name: 'Packaging', attributes: [text('material', 'Material', { filterable: true }), num('capacity_kg', 'Capacity', 'kg', { min: 0 })] },
  { slug: 'food-beverage', name: 'Food & beverage' },
  { slug: 'beverages', name: 'Beverages', parent: 'food-beverage', attributes: [num('volume_l', 'Volume', 'L', { min: 0 }), text('brand', 'Brand', { filterable: true })] },
  { slug: 'groceries', name: 'Groceries & FMCG', parent: 'food-beverage', attributes: [text('brand', 'Brand', { filterable: true }), num('shelf_life_days', 'Shelf life', 'days', { min: 0 })] },
  { slug: 'electronics', name: 'Electronics & electrical' },
  { slug: 'consumer-electronics', name: 'Consumer electronics', parent: 'electronics', attributes: [text('brand', 'Brand', { ...R, filterable: true }), text('model', 'Model'), num('warranty_months', 'Warranty', 'months', { min: 0 })] },
  { slug: 'electrical-supplies', name: 'Electrical supplies', parent: 'electronics', attributes: [num('voltage_v', 'Voltage', 'V', { min: 0 }), text('brand', 'Brand', { filterable: true })] },
  { slug: 'chemicals', name: 'Chemicals & agro-inputs' },
  { slug: 'fertilizers', name: 'Fertilizers', parent: 'chemicals', attributes: [choice('type', 'Type', ['Urea', 'DAP', 'NPS', 'NPK', 'Organic'], R), num('bag_kg', 'Bag size', 'kg', { min: 0 })] },
  { slug: 'industrial-chemicals', name: 'Industrial chemicals', parent: 'chemicals', attributes: [num('purity_pct', 'Purity', '%', { min: 0, max: 100 }), text('cas_number', 'CAS number')] },
  { slug: 'health', name: 'Health & medical' },
  { slug: 'medical-supplies', name: 'Medical supplies', parent: 'health', attributes: [flag('sterile', 'Sterile'), text('brand', 'Brand', { filterable: true })] },
  { slug: 'pharmaceuticals', name: 'Pharmaceuticals', parent: 'health', attributes: [text('dosage_form', 'Dosage form', { filterable: true }), text('strength', 'Strength')] },
  { slug: 'automotive', name: 'Automotive & machinery' },
  { slug: 'spare-parts', name: 'Spare parts', parent: 'automotive', attributes: [text('vehicle_make', 'Vehicle make', { filterable: true }), text('part_number', 'Part number')] },
  { slug: 'machinery', name: 'Machinery & equipment', parent: 'automotive', attributes: [num('power_kw', 'Power', 'kW', { min: 0 }), choice('condition', 'Condition', ['new', 'used', 'refurbished'])] },
  { slug: 'home-office', name: 'Home & office' },
  { slug: 'furniture', name: 'Furniture', parent: 'home-office', attributes: [text('material', 'Material', { filterable: true }), text('color', 'Colour', { filterable: true })] },
  { slug: 'stationery', name: 'Office & stationery', parent: 'home-office', attributes: [text('brand', 'Brand', { filterable: true })] },
  { slug: 'energy', name: 'Energy & fuel' },
  { slug: 'solar', name: 'Solar & power', parent: 'energy', attributes: [num('capacity_w', 'Capacity', 'W', { min: 0 }), text('brand', 'Brand', { filterable: true })] },
  { slug: 'apparel', name: 'Apparel & footwear' },
  { slug: 'clothing', name: 'Clothing', parent: 'apparel', attributes: [text('size', 'Size', { filterable: true }), text('color', 'Colour', { filterable: true }), text('material', 'Material')] },
  { slug: 'footwear', name: 'Footwear', parent: 'apparel', attributes: [text('size', 'Size', { filterable: true }), text('material', 'Material', { filterable: true })] },
  { slug: 'general', name: 'General goods' },
];

@Injectable()
export class CategorySeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(CategorySeeder.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Seeds in the background: an unreachable database is retried (and shown on /health/ready), not a crash at startup. */
  onApplicationBootstrap() {
    void this.seedWithRetry();
  }

  private async seedWithRetry(attempt = 1): Promise<void> {
    try {
      await this.seed();
    } catch (error) {
      const delay = Math.min(60_000, 5_000 * attempt);
      this.logger.error(`Category seeding failed (retrying in ${delay / 1000}s): ${(error as Error).message.split('\n').filter(Boolean).pop()}`);
      setTimeout(() => void this.seedWithRetry(attempt + 1), delay).unref();
    }
  }

  private async seed() {
    // Parents are listed before children, so one pass is enough.
    for (const c of CATEGORIES) {
      const parentId = c.parent ? (await this.prisma.category.findUnique({ where: { slug: c.parent } }))?.id : null;
      const attributeDefinitions = (c.attributes ?? []) as object[];
      const requiredAttributes = (c.attributes ?? []).filter((a) => a.required).map((a) => a.key);
      await this.prisma.category.upsert({
        where: { slug: c.slug },
        update: { name: c.name, parentId, requiredAttributes, attributeDefinitions },
        create: { slug: c.slug, name: c.name, parentId, requiredAttributes, attributeDefinitions },
      });
    }
    this.logger.log(`${CATEGORIES.length} categories in place`);
  }
}
