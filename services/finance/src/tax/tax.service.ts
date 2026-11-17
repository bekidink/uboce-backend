import { HttpStatus, Injectable } from '@nestjs/common';
import { type ActingOrganization, AppError, badRequest, conflict, notFound, OrganizationsClient, requireBusinessAccount, requireRole } from '@uboce/common';
import type { TaxQuote, TaxQuoteRequest } from '@uboce/contracts';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { calculateTax, type TaxRegime, TaxRuleMissing, TIN_PATTERN } from './engine.js';

const { Decimal } = Prisma;
const PROFILE_ROLES = ['owner', 'admin', 'finance_officer'];
const BUYER_ROLES = ['owner', 'admin', 'finance_officer', 'procurement_officer'];

/** Tax rules, seller profiles, buyer exemptions and the quote commerce uses at checkout (PRD v2 FIN-09). */
@Injectable()
export class TaxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsClient,
  ) {}

  // ---- Quote (internal) -----------------------------------------------------------------

  async quote(request: TaxQuoteRequest, at = new Date()): Promise<TaxQuote> {
    const [profile, rules, exemption] = await Promise.all([
      this.prisma.sellerTaxProfile.findUnique({ where: { organizationId: request.sellerOrganizationId } }),
      this.prisma.taxRule.findMany(),
      this.prisma.taxExemption.findFirst({
        where: { buyerOrganizationId: request.buyerOrganizationId, status: 'approved', validFrom: { lte: at }, validTo: { gt: at } },
        orderBy: { validTo: 'desc' },
      }),
    ]);
    const regime = (profile?.regime ?? 'none') as TaxRegime;
    try {
      const result = calculateTax({ regime, inclusive: profile?.pricesIncludeTax ?? false, exemption: exemption?.certificateNumber ?? null, rules, lines: request.lines, at });
      return {
        regime,
        inclusive: profile?.pricesIncludeTax ?? false,
        exemption: exemption?.certificateNumber ?? null,
        ...result,
        sellerLegalName: profile?.legalName ?? null,
        sellerTin: profile?.tin ?? null,
        calculatedAt: at.toISOString(),
      };
    } catch (error) {
      if (error instanceof TaxRuleMissing) throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'tax_rule_missing', error.message);
      throw error;
    }
  }

  // ---- Seller profile --------------------------------------------------------------------

  async profile(org: ActingOrganization) {
    const p = await this.prisma.sellerTaxProfile.findUnique({ where: { organizationId: org.organization.id } });
    return p ?? { organizationId: org.organization.id, regime: 'none', tin: null, vatNumber: null, legalName: null, pricesIncludeTax: false };
  }

  async saveProfile(org: ActingOrganization, userId: string, dto: { regime: TaxRegime; tin?: string | null; vatNumber?: string | null; legalName?: string | null; pricesIncludeTax?: boolean }) {
    requireBusinessAccount(org, 'set up tax');
    requireRole(org, PROFILE_ROLES, 'change tax settings');
    const tin = dto.tin?.replace(/\D/g, '') || null;
    if (tin && !TIN_PATTERN.test(tin)) throw badRequest('invalid_tin', 'A TIN is 10 digits');
    if (dto.regime !== 'none' && !tin) throw badRequest('tin_required', 'Registered sellers need a TIN');
    if (dto.regime === 'vat' && !dto.vatNumber?.trim()) throw badRequest('vat_number_required', 'VAT-registered sellers need their VAT registration number');
    const data = {
      regime: dto.regime,
      tin,
      vatNumber: dto.vatNumber?.trim() || null,
      legalName: dto.legalName?.trim() || null,
      pricesIncludeTax: dto.pricesIncludeTax ?? false,
      updatedByUserId: userId,
    };
    return this.prisma.sellerTaxProfile.upsert({ where: { organizationId: org.organization.id }, create: { organizationId: org.organization.id, ...data }, update: data });
  }

  // ---- Rules (platform administrators) ------------------------------------------------------

  rules() {
    return this.prisma.taxRule.findMany({ orderBy: [{ regime: 'asc' }, { taxClass: 'asc' }, { effectiveFrom: 'desc' }] });
  }

  /** A new rate takes over from the current rule on its effective date; the old rule is closed, never edited. */
  async addRule(userId: string, dto: { code: string; name: string; regime: 'vat' | 'tot'; taxClass: string; ratePct: string; effectiveFrom: string }) {
    const from = new Date(dto.effectiveFrom);
    if (from.getTime() < Date.now() - 60_000) throw badRequest('backdated_rule', 'Rules take effect now or later; orders already placed keep their tax');
    return this.prisma.$transaction(async (tx) => {
      await tx.taxRule.updateMany({
        where: { regime: dto.regime, taxClass: dto.taxClass, effectiveFrom: { lt: from }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: from } }] },
        data: { effectiveTo: from },
      });
      return tx.taxRule.create({ data: { code: dto.code.toUpperCase(), name: dto.name.trim(), regime: dto.regime, taxClass: dto.taxClass, ratePct: dto.ratePct, effectiveFrom: from, createdByUserId: userId } });
    });
  }

  // ---- Buyer exemptions ---------------------------------------------------------------------

  async submitExemption(org: ActingOrganization, userId: string, dto: { certificateNumber: string; documentId: string; validFrom: string; validTo: string }) {
    requireRole(org, BUYER_ROLES, 'submit tax exemptions');
    const validFrom = new Date(dto.validFrom);
    const validTo = new Date(dto.validTo);
    if (validTo <= validFrom || validTo <= new Date()) throw badRequest('invalid_period', 'The certificate must be valid after today');
    return this.prisma.taxExemption.create({
      data: { buyerOrganizationId: org.organization.id, certificateNumber: dto.certificateNumber.trim(), documentId: dto.documentId, validFrom, validTo, submittedByUserId: userId },
    });
  }

  exemptions(org: ActingOrganization) {
    return this.prisma.taxExemption.findMany({ where: { buyerOrganizationId: org.organization.id }, orderBy: { createdAt: 'desc' } });
  }

  pendingExemptions() {
    return this.prisma.taxExemption.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, take: 200 });
  }

  /** The reviewer is never the person who submitted it. */
  async reviewExemption(userId: string, id: string, approve: boolean, note: string | undefined) {
    const ex = await this.prisma.taxExemption.findUnique({ where: { id } });
    if (!ex) throw notFound('Exemption');
    if (ex.submittedByUserId === userId) throw conflict('own_submission', 'Someone else must review your own submission');
    const { count } = await this.prisma.taxExemption.updateMany({
      where: { id, status: 'pending' },
      data: { status: approve ? 'approved' : 'rejected', reviewNote: note?.trim() || null, reviewedByUserId: userId },
    });
    if (count === 0) throw conflict('already_reviewed', 'This exemption was already reviewed');
    return this.prisma.taxExemption.findUniqueOrThrow({ where: { id } });
  }

  // ---- Period summary -----------------------------------------------------------------------

  /** Output tax by rate on the seller's invoices issued in the period; credit notes are totalled separately. */
  async summary(org: ActingOrganization, from: Date, to: Date) {
    requireRole(org, [...PROFILE_ROLES, 'auditor'], 'view tax summaries');
    const lines = await this.prisma.invoiceLine.groupBy({
      by: ['taxRatePct'],
      where: { invoice: { sellerOrganizationId: org.organization.id, status: { notIn: ['draft', 'void'] }, issuedAt: { gte: from, lt: to } } },
      _sum: { subtotal: true, tax: true, total: true },
    });
    const [profile, credits] = await Promise.all([
      this.profile(org),
      this.prisma.creditNote.aggregate({ where: { invoice: { sellerOrganizationId: org.organization.id }, createdAt: { gte: from, lt: to } }, _sum: { amount: true } }),
    ]);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      regime: profile.regime,
      tin: profile.tin,
      byRate: lines.map((l) => ({ ratePct: l.taxRatePct.toFixed(2), taxable: (l._sum.subtotal ?? new Decimal(0)).toFixed(2), tax: (l._sum.tax ?? new Decimal(0)).toFixed(2), gross: (l._sum.total ?? new Decimal(0)).toFixed(2) })),
      creditNotes: (credits._sum.amount ?? new Decimal(0)).toFixed(2),
    };
  }
}
