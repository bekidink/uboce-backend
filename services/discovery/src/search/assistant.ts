import { Body, Controller, Get, HttpCode, Injectable, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { GroqClient, Public, qualified } from '@uboce/common';
import { BUSINESS_TYPES } from '@uboce/contracts';
import { IsString, Length } from 'class-validator';
import { z } from 'zod';

import { PrismaService } from '../prisma.service.js';

const DECIMAL = /^\d+(\.\d+)?$/;

const FiltersSchema = z.object({
  q: z.string().max(120).optional().nullable(),
  category: z.string().max(64).optional().nullable(),
  supplierType: z.array(z.string()).max(5).optional().nullable(),
  minPrice: z.union([z.string(), z.number()]).optional().nullable(),
  maxPrice: z.union([z.string(), z.number()]).optional().nullable(),
  deliversTo: z.string().max(80).optional().nullable(),
  verifiedOnly: z.boolean().optional().nullable(),
  inStock: z.boolean().optional().nullable(),
  sort: z.string().optional().nullable(),
  explanation: z.string().max(400).optional().nullable(),
});

class AssistDto {
  /** What the buyer is looking for, in their own words (English or Amharic). */
  @IsString()
  @Length(3, 500)
  prompt: string;
}

const SORTS = ['relevance', 'newest', 'price_asc', 'price_desc', 'rating'];

/** Marketplace search assistant (Groq): turns a request into the marketplace's own filters. */
@Injectable()
export class SearchAssistant {
  private readonly ai = new GroqClient();

  constructor(private readonly prisma: PrismaService) {}

  get enabled() {
    return this.ai.enabled;
  }

  async filters(prompt: string) {
    // Only categories that have listings, so the answer always finds something to show.
    const rows = await this.prisma.$queryRawUnsafe<{ slug: string }[]>(
      `SELECT DISTINCT unnest(category_path || ARRAY[category_slug]) AS slug FROM ${qualified('product_listings')} LIMIT 300`,
    );
    const categories = rows.map((r) => r.slug);
    const raw = await this.ai.json({
      system: `You turn a buyer's request into search filters for a B2B marketplace in Ethiopia (all sectors: agriculture, manufacturing, construction, food, electronics, chemicals, health, automotive, energy, apparel and more).
Known category slugs: ${categories.join(', ') || '(none yet)'}.
Supplier types: ${BUSINESS_TYPES.join(', ')}.
Return {"q": short keywords for full-text search or null, "category": one known slug or null, "supplierType": [types] or null,
"minPrice": number or null, "maxPrice": number or null (ETB per unit), "deliversTo": city or null, "verifiedOnly": bool, "inStock": bool,
"sort": one of ${SORTS.join(', ')}, "explanation": one sentence describing the filters}.
Only set filters the buyer asked for. Prefer a category over keywords when one fits.`,
      user: prompt,
      schema: FiltersSchema,
      maxTokens: 600,
    });
    const num = (v: unknown) =>
      v === null || v === undefined ? undefined : DECIMAL.test(String(v)) ? String(v) : undefined;
    return {
      filters: {
        q: raw.q?.trim() || undefined,
        category: raw.category && categories.includes(raw.category) ? raw.category : undefined,
        supplierType:
          raw.supplierType?.filter((t) => (BUSINESS_TYPES as readonly string[]).includes(t)).join(',') ||
          undefined,
        minPrice: num(raw.minPrice),
        maxPrice: num(raw.maxPrice),
        deliversTo: raw.deliversTo?.trim() || undefined,
        verifiedOnly: raw.verifiedOnly || undefined,
        inStock: raw.inStock || undefined,
        sort: raw.sort && SORTS.includes(raw.sort) && raw.sort !== 'relevance' ? raw.sort : undefined,
      },
      explanation: raw.explanation ?? null,
      generatedBy: this.ai.modelName,
    };
  }
}

@ApiTags('discovery')
@Public()
@Controller('discovery/assist')
export class SearchAssistantController {
  constructor(private readonly assistant: SearchAssistant) {}

  @Get('status')
  status() {
    return { enabled: this.assistant.enabled };
  }

  /** Marketplace filters from a plain-language request. */
  @Post()
  @HttpCode(200)
  assist(@Body() dto: AssistDto) {
    return this.assistant.filters(dto.prompt);
  }
}
