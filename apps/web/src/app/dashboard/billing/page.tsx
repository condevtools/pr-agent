import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { BillingClient } from "./billing-client";

type PlanId = "free" | "pro" | "enterprise";

export default async function BillingPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return (
      <BillingClient
        organizationId={null}
        initialPlan="free"
        hasStripeCustomer={false}
      />
    );
  }

  const activeOrganizationId =
    (
      session.session as {
        activeOrganizationId?: string | null;
      }
    )?.activeOrganizationId ?? null;

  let organizationId: string | null = activeOrganizationId;
  let initialPlan: PlanId = "free";
  let hasStripeCustomer = false;

  try {
    let db: any = null;

    try {
      const { getDefaultDb } = await import("@mr-agent/db");
      db = getDefaultDb();
    } catch {
      db = null;
    }

    if (db) {
      if (!organizationId) {
        const membership = await db.member.findFirst({
          where: { userId: session.user.id },
          select: { organizationId: true },
          orderBy: { createdAt: "asc" },
        });
        organizationId = membership?.organizationId ?? null;
      }

      if (organizationId) {
        const org = await db.organization.findUnique({
          where: { id: organizationId },
          select: {
            plan: true,
            stripeCustomerId: true,
          },
        });

        if (org) {
          initialPlan = org.plan;
          hasStripeCustomer = Boolean(org.stripeCustomerId);
        }
      }
    }
  } catch (error) {
    console.warn("[billing/page] Could not load organization billing context", error);
  }

  return (
    <BillingClient
      organizationId={organizationId}
      initialPlan={initialPlan}
      hasStripeCustomer={hasStripeCustomer}
    />
  );
}
