import { randomUUID } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AdministrationClient,
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  OrganizationsClient,
  type PaginationQueryDto,
  skipTake,
  toPage,
} from '@uboce/common';
import type { InternalDocument } from '@uboce/contracts';

import { env } from '../config.js';
import type { Document, Prisma } from '../generated/prisma/client.js';
import type { DocumentClassification, GranteeType } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma.service.js';
import { ALLOWED_CONTENT_TYPES, matchesSignature, retentionUntil, safeFileName } from './content-rules.js';
import { Storage } from './storage.js';

export interface Caller {
  userId: string;
  /** Acting organization from x-organization-id, still unverified. */
  organizationId?: string;
  ipAddress?: string;
}

/** Which staff role may read which documents, when a review case grants access. */
const REVIEWER_FOR: Partial<Record<DocumentClassification, string>> = {
  identity_document: 'verification_reviewer',
  business_registration: 'verification_reviewer',
  license: 'verification_reviewer',
  tax_certificate: 'verification_reviewer',
  delivery_evidence: 'dispute_reviewer',
  inspection_evidence: 'dispute_reviewer',
  dispute_evidence: 'dispute_reviewer',
  invoice: 'dispute_reviewer',
};

const publicView = (d: Document) => ({
  id: d.id,
  ownerUserId: d.ownerUserId,
  ownerOrganizationId: d.ownerOrganizationId,
  classification: d.classification,
  fileName: d.fileName,
  contentType: d.contentType,
  sizeBytes: d.sizeBytes,
  sha256: d.sha256,
  status: d.status,
  rejectionReason: d.rejectionReason,
  retentionUntil: d.retentionUntil,
  legalHold: d.legalHold,
  createdAt: d.createdAt,
  uploadedAt: d.uploadedAt,
});

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: Storage,
    private readonly organizations: OrganizationsClient,
    private readonly administration: AdministrationClient,
  ) {}

  /** Step 1: register the file and get a short-lived signed upload URL. */
  async createUpload(caller: Caller, input: { classification: DocumentClassification; fileName: string; contentType: string; sizeBytes: number }) {
    if (!(ALLOWED_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
      throw badRequest('unsupported_type', `Allowed types: ${ALLOWED_CONTENT_TYPES.join(', ')}`);
    }
    if (input.sizeBytes > env.MAX_UPLOAD_BYTES) throw badRequest('too_large', `Files may be at most ${env.MAX_UPLOAD_BYTES} bytes`);
    const organizationId = caller.organizationId ? await this.verifiedOrganization(caller) : null;

    const id = randomUUID();
    // The key reveals nothing about the owner or the file.
    const storageKey = `${new Date().toISOString().slice(0, 7)}/${id}`;
    const document = await this.prisma.document.create({
      data: {
        id,
        ownerUserId: caller.userId,
        ownerOrganizationId: organizationId,
        classification: input.classification,
        fileName: safeFileName(input.fileName),
        contentType: input.contentType,
        declaredSize: input.sizeBytes,
        storageKey,
        retentionUntil: retentionUntil(input.classification),
      },
    });
    await this.log(document.id, 'upload_url', caller);
    return {
      document: publicView(document),
      upload: {
        method: 'PUT',
        url: await this.storage.uploadUrl(storageKey, input.contentType),
        headers: { 'content-type': input.contentType },
        expiresInSeconds: env.LINK_TTL_SECONDS,
      },
    };
  }

  /** Step 2: after uploading, verify size, type and checksum. Bad files are rejected and erased. */
  async completeUpload(caller: Caller, documentId: string) {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document || document.ownerUserId !== caller.userId) throw notFound('Document');
    if (document.status !== 'pending_upload') return publicView(document);

    const stored = await this.storage.inspect(document.storageKey);
    if (!stored) throw new AppError(HttpStatus.CONFLICT, 'not_uploaded', 'Nothing has been uploaded for this document yet');

    let problem: string | null = null;
    if (stored.size > env.MAX_UPLOAD_BYTES || stored.size !== document.declaredSize) problem = 'Size does not match what was declared';
    else if (!matchesSignature(document.contentType, stored.head)) problem = `File content is not a valid ${document.contentType}`;

    if (problem) {
      await this.storage.remove(document.storageKey);
      const rejected = await this.prisma.document.update({ where: { id: documentId }, data: { status: 'rejected', rejectionReason: problem } });
      return publicView(rejected);
    }
    // Malware scanning would run here before release (PRD 5.17 "where feasible"); see README.
    const available = await this.prisma.document.update({
      where: { id: documentId },
      data: { status: 'available', sizeBytes: stored.size, sha256: stored.sha256, uploadedAt: new Date() },
    });
    return publicView(available);
  }

  async get(caller: Caller, documentId: string) {
    return publicView(await this.readable(caller, documentId));
  }

  /** A short-lived signed download link. Every one issued is logged. */
  async downloadUrl(caller: Caller, documentId: string) {
    const document = await this.readable(caller, documentId);
    if (document.status !== 'available') throw conflict('not_available', `This document is ${document.status}`);
    await this.log(document.id, 'download_url', caller);
    return {
      url: await this.storage.downloadUrl(document.storageKey, document.fileName, document.contentType),
      expiresInSeconds: env.LINK_TTL_SECONDS,
    };
  }

  async list(caller: Caller, query: PaginationQueryDto) {
    const organizationId = caller.organizationId ? await this.verifiedOrganization(caller) : null;
    const where: Prisma.DocumentWhereInput = {
      status: { not: 'deleted' },
      ...(organizationId ? { ownerOrganizationId: organizationId } : { ownerUserId: caller.userId, ownerOrganizationId: null }),
    };
    const [items, total] = await Promise.all([
      this.prisma.document.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.document.count({ where }),
    ]);
    return toPage(items.map(publicView), total, query);
  }

  /** The owner shares a document with another organization, e.g. delivery evidence with the buyer. */
  async share(caller: Caller, documentId: string, organizationId: string, reason: string) {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document || !(await this.isOwner(caller, document))) throw notFound('Document');
    await this.prisma.documentGrant.create({
      data: { documentId, granteeType: 'organization', granteeId: organizationId, reason, grantedBy: `user:${caller.userId}` },
    });
    await this.log(documentId, 'grant', caller);
    return { granted: true };
  }

  /** Deletion respects retention and legal hold (PRD 5.17, 9). */
  async remove(caller: Caller, documentId: string) {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document || !(await this.isOwner(caller, document))) throw notFound('Document');
    if (document.legalHold) throw conflict('legal_hold', 'This document is under legal hold');
    if (document.retentionUntil && document.retentionUntil > new Date()) {
      throw conflict('retention_period', `This document must be kept until ${document.retentionUntil.toISOString().slice(0, 10)}`);
    }
    await this.storage.remove(document.storageKey).catch(() => {});
    await this.prisma.document.update({ where: { id: documentId }, data: { status: 'deleted', deletedAt: new Date() } });
    await this.log(documentId, 'delete', caller);
  }

  // ---- Internal ----------------------------------------------------------------

  async internalGet(documentId: string): Promise<InternalDocument> {
    const d = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!d) throw notFound('Document');
    return {
      id: d.id,
      ownerOrganizationId: d.ownerOrganizationId,
      ownerUserId: d.ownerUserId,
      classification: d.classification,
      status: d.status,
      contentType: d.contentType,
      sha256: d.sha256,
    };
  }

  async internalGrant(service: string, documentId: string, granteeType: GranteeType, granteeId: string, reason: string) {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) throw notFound('Document');
    const existing = await this.prisma.documentGrant.findFirst({ where: { documentId, granteeType, granteeId, revokedAt: null } });
    if (!existing) {
      await this.prisma.documentGrant.create({ data: { documentId, granteeType, granteeId, reason, grantedBy: `service:${service}` } });
      await this.prisma.documentAccessLog.create({ data: { documentId, action: 'grant', actorService: service } });
    }
    return { granted: true };
  }

  // ---- Access --------------------------------------------------------------------

  private async readable(caller: Caller, documentId: string) {
    const document = await this.prisma.document.findUnique({ where: { id: documentId }, include: { grants: true } });
    if (!document || document.status === 'deleted') throw notFound('Document');
    if (await this.isOwner(caller, document)) return document;

    const now = new Date();
    const live = document.grants.filter((g) => !g.revokedAt && (!g.expiresAt || g.expiresAt > now));
    if (live.some((g) => g.granteeType === 'user' && g.granteeId === caller.userId)) return document;
    if (caller.organizationId && live.some((g) => g.granteeType === 'organization' && g.granteeId === caller.organizationId)) {
      await this.verifiedOrganization(caller);
      return document;
    }
    // Platform reviewers, only for documents attached to a review case and only for their area.
    const reviewerRole = REVIEWER_FOR[document.classification];
    if (reviewerRole && live.some((g) => g.granteeType === 'case')) {
      const roles = await this.administration.platformRoles(caller.userId);
      if (roles.includes(reviewerRole) || roles.includes('platform_admin')) return document;
    }
    throw notFound('Document');
  }

  private async isOwner(caller: Caller, document: Document) {
    if (document.ownerUserId === caller.userId) return true;
    if (document.ownerOrganizationId && caller.organizationId === document.ownerOrganizationId) {
      await this.verifiedOrganization(caller);
      return true;
    }
    return false;
  }

  /** The x-organization-id claim is untrusted until Organization confirms membership. */
  private async verifiedOrganization(caller: Caller): Promise<string> {
    const membership = await this.organizations.getMembership(caller.organizationId!, caller.userId);
    if (!membership) throw forbidden('You are not a member of that organization');
    return membership.organization.id;
  }

  private log(documentId: string, action: string, caller: Caller) {
    return this.prisma.documentAccessLog.create({
      data: { documentId, action, actorUserId: caller.userId, organizationId: caller.organizationId, ipAddress: caller.ipAddress },
    });
  }
}
