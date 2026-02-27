import { getDefaultDb } from "@mr-agent/db";

export type OrganizationPlan = "free" | "pro" | "enterprise";
export type BillingMemberRole = "owner" | "admin" | "member";

export interface BillingOrganizationContext {
  organizationId: string;
  role: BillingMemberRole;
  plan: OrganizationPlan;
  stripeCustomerId: string | null;
}

export function canManageBilling(role: BillingMemberRole): boolean {
  return role === "owner" || role === "admin";
}

export async function getBillingOrganizationMembership(params: {
  userId: string;
  organizationId: string;
}): Promise<BillingOrganizationContext | null> {
  const userId = params.userId.trim();
  const organizationId = params.organizationId.trim();
  if (!userId || !organizationId) {
    return null;
  }

  const db = getDefaultDb();
  if (!db) {
    return null;
  }

  const membership = await db.member.findFirst({
    where: {
      userId,
      organizationId,
    },
    select: {
      organizationId: true,
      role: true,
      organization: {
        select: {
          plan: true,
          stripeCustomerId: true,
        },
      },
    },
  });
  if (!membership) {
    return null;
  }

  return toBillingContext(membership);
}

export async function resolveBillingOrganizationForUser(params: {
  userId: string;
  preferredOrganizationId?: string | null;
  fallbackToFirstMembership?: boolean;
}): Promise<BillingOrganizationContext | null> {
  const userId = params.userId.trim();
  if (!userId) {
    return null;
  }

  const preferredOrganizationId = params.preferredOrganizationId?.trim();
  if (preferredOrganizationId) {
    const exact = await getBillingOrganizationMembership({
      userId,
      organizationId: preferredOrganizationId,
    });
    if (exact) {
      return exact;
    }
    if (!params.fallbackToFirstMembership) {
      return null;
    }
  }

  const db = getDefaultDb();
  if (!db) {
    return null;
  }

  const membership = await db.member.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: {
      organizationId: true,
      role: true,
      organization: {
        select: {
          plan: true,
          stripeCustomerId: true,
        },
      },
    },
  });
  if (!membership) {
    return null;
  }
  return toBillingContext(membership);
}

function toBillingContext(row: {
  organizationId: string;
  role: string;
  organization: {
    plan: string;
    stripeCustomerId: string | null;
  };
}): BillingOrganizationContext {
  return {
    organizationId: row.organizationId,
    role: normalizeRole(row.role),
    plan: normalizePlan(row.organization.plan),
    stripeCustomerId: row.organization.stripeCustomerId,
  };
}

function normalizeRole(role: string): BillingMemberRole {
  const normalized = role.trim().toLowerCase();
  if (normalized === "owner" || normalized === "admin") {
    return normalized;
  }
  return "member";
}

function normalizePlan(plan: string): OrganizationPlan {
  const normalized = plan.trim().toLowerCase();
  if (
    normalized === "free" ||
    normalized === "pro" ||
    normalized === "enterprise"
  ) {
    return normalized;
  }
  return "free";
}
