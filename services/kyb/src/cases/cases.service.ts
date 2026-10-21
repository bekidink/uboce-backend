import { Injectable } from '@nestjs/common';
import {
  badRequest,
  type CaseStatus,
  canTransitionCase,
  conflict,
  DocumentsClient,
  emitEvent,
  forbidden,
  missingRequirements,
  nextAction,
  notFound,
  OPEN_CASE_STATUSES,
  type PaginationQueryDto,
  skipTake,
  toPage,
} from '@uboce/common';

import { SERVICE_NAME } from '../config.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { EVENT_TYPE, POLICY_VERSION, TIERS, VALIDITY_DAYS } from './policy.js';

type Tx = Prisma.TransactionClient;
type Case = Prisma.VerificationCaseGetPayload<{ include: { evidence: true } }>;

/** Who is acting on the subject's side, and how to check their documents. */
export interface SubjectContext {
  subjectId: string;
  actorUserId: string;
  /** True when the document is the subject's own, available evidence. */
  ownsDocument: (doc: { ownerUserId: string; ownerOrganizationId: string | null }) => boolean;
}

const decisionToEvent: Partial<Record<CaseStatus, 'submitted' | 'approved' | 'rejected' | 'needs_information' | 'suspended' | 'expired'>> = {
  submitted: 'submitted',
  approved: 'approved',
  rejected: 'rejected',
  needs_information: 'needs_information',
  suspended: 'suspended',
  expired: 'expired',
};

/** What the subject sees: status and next step, never reviewer notes or checks (PRD 6.1). */
const subjectView = (c: Case) => {
  const required = Object.keys(TIERS[c.tier] ?? {});
  const missing = missingRequirements(required, c.evidence.map((e) => e.requirement));
  return {
    id: c.id,
    tier: c.tier,
    status: c.status,
    requirements: required.map((r) => ({ requirement: r, provided: !missing.includes(r) })),
    nextAction: nextAction(c.status as CaseStatus, missing),
    submittedAt: c.submittedAt,
    decidedAt: c.decidedAt,
    expiresAt: c.expiresAt,
    createdAt: c.createdAt,
  };
};

@Injectable()
export class CasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsClient,
  ) {}

  // ---- Subject side -----------------------------------------------------------------

  async open(ctx: SubjectContext, tier: string) {
    if (!TIERS[tier]) throw badRequest('unknown_tier', `Tiers: ${Object.keys(TIERS).join(', ')}`);
    const open = await this.prisma.verificationCase.findFirst({ where: { subjectId: ctx.subjectId, status: { in: OPEN_CASE_STATUSES } } });
    if (open) throw conflict('case_open', 'There is already an open or approved verification');
    const created = await this.prisma.$transaction(async (tx) => {
      const c = await tx.verificationCase.create({ data: { subjectId: ctx.subjectId, tier, policyVersion: POLICY_VERSION }, include: { evidence: true } });
      await this.history(tx, c.id, null, 'draft', ctx.actorUserId);
      return c;
    });
    return subjectView(created);
  }

  async addEvidence(ctx: SubjectContext, caseId: string, requirement: string, documentId: string) {
    const c = await this.subjectCase(ctx, caseId);
    if (c.status !== 'draft' && c.status !== 'needs_information') throw conflict('case_locked', 'Evidence can only be added before submission');
    const classification = TIERS[c.tier]?.[requirement];
    if (!classification) throw badRequest('unknown_requirement', `This tier needs: ${Object.keys(TIERS[c.tier] ?? {}).join(', ')}`);

    const doc = await this.documents.get(documentId);
    if (!doc || !ctx.ownsDocument(doc) || doc.status !== 'available') throw badRequest('invalid_document', 'Use one of your own uploaded documents');
    if (doc.classification !== classification) throw badRequest('wrong_document_type', `${requirement} must be a ${classification} document`);

    // Reviewers can read it only through this case.
    await this.documents.grant(documentId, { type: 'case', id: `kyb:${caseId}` }, `Evidence for ${requirement}`);
    await this.prisma.caseEvidence.upsert({
      where: { caseId_requirement: { caseId, requirement } },
      update: { documentId, addedByUserId: ctx.actorUserId },
      create: { caseId, requirement, documentId, addedByUserId: ctx.actorUserId },
    });
    return subjectView(await this.subjectCase(ctx, caseId));
  }

  async submit(ctx: SubjectContext, caseId: string) {
    const c = await this.subjectCase(ctx, caseId);
    const missing = missingRequirements(Object.keys(TIERS[c.tier] ?? {}), c.evidence.map((e) => e.requirement));
    if (missing.length) throw badRequest('evidence_missing', `Still needed: ${missing.join(', ')}`);
    await this.move(caseId, c.status as CaseStatus, 'submitted', 'subject', ctx.actorUserId, { submittedAt: new Date() });
    return subjectView(await this.subjectCase(ctx, caseId));
  }

  async mine(subjectId: string) {
    const cases = await this.prisma.verificationCase.findMany({ where: { subjectId }, include: { evidence: true }, orderBy: { createdAt: 'desc' } });
    return cases.map(subjectView);
  }

  // ---- Reviewer side --------------------------------------------------------------------

  async queue(status: CaseStatus, query: PaginationQueryDto) {
    const where = { status };
    const [items, total] = await Promise.all([
      this.prisma.verificationCase.findMany({ where, include: { evidence: true }, orderBy: { submittedAt: 'asc' }, ...skipTake(query) }),
      this.prisma.verificationCase.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  /** Full case for reviewers, including checks and decision history. */
  async reviewerView(caseId: string) {
    const c = await this.prisma.verificationCase.findUnique({
      where: { id: caseId },
      include: { evidence: true, checks: { orderBy: { createdAt: 'asc' } }, decisions: { orderBy: { createdAt: 'asc' } } },
    });
    if (!c) throw notFound('Case');
    return c;
  }

  async claim(reviewerId: string, caseId: string, isSubjectParty: (subjectId: string) => Promise<boolean>) {
    const c = await this.reviewerView(caseId);
    if (await isSubjectParty(c.subjectId)) throw forbidden('You cannot review your own verification');
    await this.move(caseId, c.status as CaseStatus, 'in_review', 'reviewer', reviewerId, { reviewerUserId: reviewerId });
    return this.reviewerView(caseId);
  }

  async recordCheck(reviewerId: string, caseId: string, check: { type: string; result: string; details?: string }) {
    const c = await this.reviewerView(caseId);
    if (c.status !== 'in_review') throw conflict('not_in_review', 'Claim the case before recording checks');
    if (c.reviewerUserId !== reviewerId) throw forbidden('Another reviewer has this case');
    await this.prisma.caseCheck.create({ data: { ...check, caseId, performedByUserId: reviewerId } });
    return this.reviewerView(caseId);
  }

  async decide(reviewerId: string, caseId: string, decision: 'approved' | 'rejected' | 'needs_information', reasonCode: string, notes?: string) {
    const c = await this.reviewerView(caseId);
    if (c.status === 'in_review' && c.reviewerUserId !== reviewerId) throw forbidden('Another reviewer has this case');
    const extra =
      decision === 'approved'
        ? { decidedAt: new Date(), expiresAt: new Date(Date.now() + VALIDITY_DAYS * 86_400_000), reasonCode }
        : { decidedAt: new Date(), reasonCode };
    await this.move(caseId, c.status as CaseStatus, decision, 'reviewer', reviewerId, extra, reasonCode, notes);
    return this.reviewerView(caseId);
  }

  async suspend(reviewerId: string, caseId: string, reasonCode: string, notes?: string) {
    const c = await this.reviewerView(caseId);
    await this.move(caseId, c.status as CaseStatus, 'suspended', 'reviewer', reviewerId, { reasonCode }, reasonCode, notes);
    return this.reviewerView(caseId);
  }

  /** Expires approvals past their validity; the subject must re-verify (PRD 5.3). */
  async expireDue() {
    const due = await this.prisma.verificationCase.findMany({ where: { status: 'approved', expiresAt: { lte: new Date() } }, select: { id: true } });
    for (const { id } of due) await this.move(id, 'approved', 'expired', 'system', null, {}, 'validity_elapsed').catch(() => {});
    return due.length;
  }

  /** The minimum other services need (PRD 5.3: expose only minimal status). */
  async status(subjectId: string) {
    const c = await this.prisma.verificationCase.findFirst({ where: { subjectId }, orderBy: { createdAt: 'desc' } });
    return { subjectId, status: c?.status ?? 'none', tier: c?.status === 'approved' ? c.tier : null, expiresAt: c?.status === 'approved' ? c.expiresAt : null };
  }

  // ---- Internals --------------------------------------------------------------------

  private async move(
    caseId: string,
    from: CaseStatus,
    to: CaseStatus,
    actor: 'subject' | 'reviewer' | 'system',
    actorUserId: string | null,
    data: Prisma.VerificationCaseUpdateManyMutationInput,
    reasonCode?: string,
    notes?: string,
  ) {
    if (!canTransitionCase(from, to, actor)) throw conflict('invalid_transition', `A ${from} case cannot become ${to}`);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.verificationCase.updateMany({ where: { id: caseId, status: from }, data: { ...data, status: to } });
      if (count === 0) throw conflict('concurrent_change', 'The case changed; reload and try again');
      await this.history(tx, caseId, from, to, actorUserId, reasonCode, notes);
      const decision = decisionToEvent[to];
      if (decision) {
        const c = await tx.verificationCase.findUniqueOrThrow({ where: { id: caseId } });
        await emitEvent(tx, SERVICE_NAME, EVENT_TYPE, caseId, {
          caseId,
          subjectId: c.subjectId,
          tier: c.tier,
          decision,
          reasonCode: reasonCode ?? null,
          policyVersion: c.policyVersion,
          expiresAt: c.expiresAt?.toISOString() ?? null,
        });
      }
    });
  }

  private history(tx: Tx, caseId: string, from: CaseStatus | null, to: CaseStatus, actorUserId: string | null, reasonCode?: string, notes?: string) {
    return tx.caseDecision.create({
      data: { caseId, fromStatus: from, toStatus: to, actorUserId, reasonCode, internalNotes: notes, policyVersion: POLICY_VERSION },
    });
  }

  private async subjectCase(ctx: SubjectContext, caseId: string) {
    const c = await this.prisma.verificationCase.findFirst({ where: { id: caseId, subjectId: ctx.subjectId }, include: { evidence: true } });
    if (!c) throw notFound('Case');
    return c;
  }
}
