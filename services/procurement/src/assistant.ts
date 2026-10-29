import { Body, Controller, Get, HttpCode, Injectable, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type ActingOrganization, ActingOrg, ActsForOrganization, badRequest, GroqClient, OrganizationsClient, requireRole } from '@uboce/common';
import { IsString, Length } from 'class-validator';
import { z } from 'zod';

import { ProcurementService } from './procurement.service.js';
import { BUYER_ROLES } from './rules.js';

const UNITS = ['kg', 'quintal', 'tonne', 'gram', 'litre', 'piece', 'box', 'bag', 'carton', 'metre', 'square_metre'] as const;

const DraftSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(2000).optional().nullable(),
  // Models sometimes send numbers as strings; clamp to 1–90 days.
  responseDays: z
    .preprocess((v) => {
      const n = Number(v);
      return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : Math.min(90, Math.max(1, Math.round(n)));
    }, z.number().nullable())
    .optional(),
  deliveryLocation: z.string().max(300).optional().nullable(),
  lines: z
    .array(
      z.object({
        description: z.string().min(2).max(500),
        quantity: z.union([z.string(), z.number()]).transform((v) => String(v)),
        unitOfMeasure: z.string(),
        specifications: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform((v) => String(v))).optional().nullable(),
      }),
    )
    .min(1)
    .max(30),
});

const ComparisonSchema = z.object({
  recommendation: z.string().max(600),
  recommendedQuotationId: z.string().nullable().optional(),
  points: z.array(z.object({ text: z.string().max(400), quotationIds: z.array(z.string()) })).max(8),
  questions: z.array(z.string().max(300)).max(5).optional(),
});

class DraftDto {
  /** What the buyer needs, in their own words (English or Amharic). */
  @IsString()
  @Length(5, 3000)
  prompt: string;
}

/** Unit words buyers use → our units. */
const UNIT_ALIASES: Record<string, (typeof UNITS)[number]> = {
  kilogram: 'kg', kilograms: 'kg', kgs: 'kg', ton: 'tonne', tons: 'tonne', tonnes: 'tonne', mt: 'tonne', quintals: 'quintal', qt: 'quintal',
  liter: 'litre', liters: 'litre', litres: 'litre', l: 'litre', pieces: 'piece', pcs: 'piece', pc: 'piece', units: 'piece', unit: 'piece',
  bags: 'bag', sacks: 'bag', sack: 'bag', boxes: 'box', cartons: 'carton', meters: 'metre', metres: 'metre', m: 'metre', grams: 'gram', g: 'gram', m2: 'square_metre',
};
const toUnit = (u: string) => {
  const k = u.trim().toLowerCase();
  return (UNITS as readonly string[]).includes(k) ? (k as (typeof UNITS)[number]) : (UNIT_ALIASES[k] ?? 'piece');
};

/** AI help for buyers (Groq): draft an RFQ from a description, and compare quotations. */
@Injectable()
export class ProcurementAssistant {
  private readonly ai = new GroqClient();

  constructor(
    private readonly procurement: ProcurementService,
    private readonly organizations: OrganizationsClient,
  ) {}

  async draft(org: ActingOrganization, prompt: string) {
    requireRole(org, BUYER_ROLES, 'draft RFQs');
    const draft = await this.ai.json({
      system: `You help Ethiopian businesses write requests for quotation (RFQs) for agricultural and industrial goods.
Turn the buyer's request into a clear RFQ draft. Use these units only: ${UNITS.join(', ')} (1 quintal = 100 kg).
Return {"title": short title, "description": optional notes for suppliers, "responseDays": days suppliers get to quote (default 7),
"deliveryLocation": if mentioned, "lines": [{"description", "quantity" (number as a string), "unitOfMeasure", "specifications": {key: value} e.g. grade, origin, moisture}]}.
Only include what the buyer asked for; do not invent quantities they didn't give (use "1" and say so in the description).`,
      user: prompt,
      schema: DraftSchema,
    });
    return {
      ...draft,
      lines: draft.lines.map((l) => ({
        ...l,
        quantity: /^\d+(\.\d+)?$/.test(l.quantity) ? l.quantity : '1',
        unitOfMeasure: toUnit(l.unitOfMeasure),
        specifications: l.specifications ?? undefined,
      })),
      generatedBy: this.ai.modelName,
    };
  }

  /** Compares an RFQ's quotations; every point names the quotations it is about. */
  async compare(org: ActingOrganization, rfqId: string) {
    const rfq = await this.procurement.getRfq(org, rfqId);
    const quotations = (await this.procurement.compareQuotations(org, rfqId)).filter((q) => q.status !== 'rejected');
    if (quotations.length < 1) throw badRequest('no_quotations', 'There are no quotations to compare yet');
    const orgs = await Promise.all([...new Set(quotations.map((q) => q.supplierOrganizationId))].map((id) => this.organizations.getOrganization(id).catch(() => null)));
    const names = new Map(orgs.filter((o) => o !== null).map((o) => [o.id, o]));
    const facts = quotations.map((q) => ({
      quotationId: q.id,
      supplier: names.get(q.supplierOrganizationId)?.name ?? 'Supplier',
      verified: names.get(q.supplierOrganizationId)?.verificationStatus === 'verified',
      total: `${q.total.toString()} ${q.currency}`,
      validUntil: q.validUntil.toISOString().slice(0, 10),
      expired: q.expired,
      revision: q.revision,
      notes: q.notes,
      lines: q.lines.map((l) => {
        const rl = rfq.lines.find((x) => x.id === l.rfqLineId);
        return { item: rl?.description, quantity: `${l.quantity.toString()} ${rl?.unitOfMeasure ?? ''}`, unitPrice: l.unitPrice.toString(), leadTimeDays: l.leadTimeDays };
      }),
    }));
    const result = await this.ai.json({
      system: `You advise a buyer choosing between supplier quotations for an RFQ. Use only the data given.
Weigh total price, lead times, validity (expired quotations cannot be accepted), verification and notes.
Return {"recommendation": one or two sentences, "recommendedQuotationId": id or null, "points": [{"text", "quotationIds": [ids it is about]}], "questions": [things to clarify with suppliers]}.
Quote numbers exactly as given. Never invent suppliers, prices or terms.`,
      user: JSON.stringify({ rfq: { title: rfq.title, lines: rfq.lines.map((l) => ({ description: l.description, quantity: `${l.quantity.toString()} ${l.unitOfMeasure}` })) }, quotations: facts }),
      schema: ComparisonSchema,
    });
    const ids = new Set(quotations.map((q) => q.id));
    return {
      recommendation: result.recommendation,
      recommendedQuotationId: result.recommendedQuotationId && ids.has(result.recommendedQuotationId) ? result.recommendedQuotationId : null,
      points: result.points.filter((p) => p.quotationIds.length && p.quotationIds.every((id) => ids.has(id))),
      questions: result.questions ?? [],
      generatedBy: this.ai.modelName,
    };
  }

  get enabled() {
    return this.ai.enabled;
  }
}

@ApiTags('rfqs')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('rfqs')
export class AssistantController {
  constructor(private readonly assistant: ProcurementAssistant) {}

  /** Whether AI help is available here. */
  @Get('assist/status')
  status() {
    return { enabled: this.assistant.enabled };
  }

  /** Draft an RFQ from a plain-language request (review it before saving). */
  @Post('assist')
  @HttpCode(200)
  draft(@ActingOrg() org: ActingOrganization, @Body() dto: DraftDto) {
    return this.assistant.draft(org, dto.prompt);
  }

  /** AI comparison of an RFQ's quotations. */
  @Post(':rfqId/quotations/analysis')
  @HttpCode(200)
  compare(@ActingOrg() org: ActingOrganization, @Param('rfqId', new ParseUUIDPipe()) rfqId: string) {
    return this.assistant.compare(org, rfqId);
  }
}
