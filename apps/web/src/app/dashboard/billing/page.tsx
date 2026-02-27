import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { resolveBillingOrganizationForUser } from "@/lib/organization-billing";
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
    const billingContext = await resolveBillingOrganizationForUser({
      userId: session.user.id,
      preferredOrganizationId: activeOrganizationId,
      fallbackToFirstMembership: true,
    });
    if (billingContext) {
      organizationId = billingContext.organizationId;
      initialPlan = billingContext.plan;
      hasStripeCustomer = Boolean(billingContext.stripeCustomerId);
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
