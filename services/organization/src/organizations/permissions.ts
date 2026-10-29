import type { MembershipRole } from '../generated/prisma/enums.js';

/** Actions on an organization's own records. Other services define their own permissions. */
export type Permission = 'organization:read' | 'organization:update' | 'members:read' | 'members:manage' | 'branches:manage';

const READ: Permission[] = ['organization:read', 'members:read'];

// Least privilege (PRD 3.1): only owner/admin manage the organization itself;
// operational roles can see it and their colleagues, nothing more here.
export const ROLE_PERMISSIONS: Record<MembershipRole, readonly Permission[]> = {
  owner: ['organization:read', 'organization:update', 'members:read', 'members:manage', 'branches:manage'],
  admin: ['organization:read', 'organization:update', 'members:read', 'members:manage', 'branches:manage'],
  procurement_officer: READ,
  sales_representative: READ,
  warehouse_operator: READ,
  farmer: READ,
  quality_inspector: READ,
  manufacturer: READ,
  logistics_operator: READ,
  finance_officer: READ,
  auditor: READ,
  driver: ['organization:read'],
};

export const hasPermission = (role: MembershipRole, permission: Permission) =>
  ROLE_PERMISSIONS[role].includes(permission);

/**
 * Who may grant or change a role: only owners can create or remove owners,
 * and admins cannot act on owners.
 */
export const canAssignRole = (actorRole: MembershipRole, targetRole: MembershipRole) =>
  hasPermission(actorRole, 'members:manage') && (targetRole !== 'owner' || actorRole === 'owner');
