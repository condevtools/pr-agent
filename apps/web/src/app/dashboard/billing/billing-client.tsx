"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

type PlanId = "free" | "pro" | "enterprise";

type BillingClientProps = {
  organizationId: string | null;
  initialPlan: PlanId;
  hasStripeCustomer: boolean;
};

type CheckoutPlan = Exclude<PlanId, "free">;

type PlanCard = {
  id: PlanId;
  name: string;
  price: string;
  period: string;
  description: string;
  features: string[];
  popular?: boolean;
};

const PLAN_CARDS: readonly PlanCard[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    period: "forever",
    description: "For individuals and small open-source projects",
    features: [
      "50 reviews / month",
      "3 repositories",
      "Community support",
      "Basic slash commands",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "$29",
    period: "per month",
    description: "For growing teams that need more power",
    features: [
      "Unlimited reviews",
      "25 repositories",
      "Priority support",
      "All slash commands",
      "Custom review rules",
      "Team management",
    ],
    popular: true,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "$99",
    period: "per month",
    description: "For organizations with advanced needs",
    features: [
      "Unlimited everything",
      "Unlimited repositories",
      "Dedicated support",
      "SSO / SAML",
      "Audit logs",
      "Custom integrations",
      "SLA guarantee",
    ],
  },
];

function getPlanActionLabel(planId: PlanId, currentPlan: PlanId): string {
  if (planId === currentPlan) return "Current Plan";
  if (planId === "pro") return "Upgrade to Pro";
  if (planId === "enterprise") return "Upgrade to Enterprise";
  return "Downgrade to Free";
}

export function BillingClient({
  organizationId,
  initialPlan,
  hasStripeCustomer,
}: BillingClientProps) {
  const searchParams = useSearchParams();

  const [checkoutLoadingPlan, setCheckoutLoadingPlan] =
    useState<CheckoutPlan | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const success = searchParams.get("success") === "true";
  const canceled = searchParams.get("canceled") === "true";

  const canManagePortal = hasStripeCustomer && Boolean(organizationId);

  const currentPlan = initialPlan;

  const currentPlanDisplay = useMemo(() => {
    if (currentPlan === "enterprise") return "Enterprise";
    if (currentPlan === "pro") return "Pro";
    return "Free";
  }, [currentPlan]);

  const handleCheckout = async (planId: CheckoutPlan) => {
    if (!organizationId || checkoutLoadingPlan || portalLoading) return;

    setError(null);
    setCheckoutLoadingPlan(planId);

    try {
      const response = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          planId,
          organizationId,
        }),
      });

      const data = (await response.json()) as { error?: string; url?: string | null };

      if (!response.ok || !data.url) {
        throw new Error(data.error ?? "Failed to create checkout session.");
      }

      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start checkout.");
      setCheckoutLoadingPlan(null);
    }
  };

  const handleOpenPortal = async () => {
    if (!organizationId || !canManagePortal || checkoutLoadingPlan || portalLoading) {
      return;
    }

    setError(null);
    setPortalLoading(true);

    try {
      const response = await fetch("/api/stripe/portal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          organizationId,
        }),
      });

      const data = (await response.json()) as { error?: string; url?: string | null };

      if (!response.ok || !data.url) {
        throw new Error(data.error ?? "Failed to open billing portal.");
      }

      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open billing portal.");
      setPortalLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Billing</h1>
        <p className="mt-1 text-gray-400">Manage your subscription and billing information.</p>
      </div>

      {!organizationId && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-300">
          No active organization was found for your account. Create or switch to an organization
          before managing billing.
        </div>
      )}

      {success && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm text-emerald-300">
          Checkout completed successfully. Subscription details will update shortly.
        </div>
      )}

      {canceled && (
        <div className="rounded-xl border border-gray-700 bg-gray-900 p-4 text-sm text-gray-300">
          Checkout was canceled. No billing changes were made.
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-4 text-sm text-rose-300">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-6 flex items-center justify-between gap-6">
        <div>
          <p className="text-sm text-gray-400">Current Plan</p>
          <p className="text-xl font-bold text-indigo-300 mt-1">{currentPlanDisplay}</p>
          <p className="text-sm text-gray-400 mt-1">
            Billing is managed via Stripe checkout and customer portal.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleOpenPortal}
            disabled={!canManagePortal || portalLoading || checkoutLoadingPlan !== null}
            className="rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-300 transition-colors hover:border-gray-600 hover:bg-gray-750 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {portalLoading ? "Opening..." : "Manage Billing"}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-gray-800 bg-gray-900 p-6">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-medium text-gray-300">Monthly Review Usage</p>
          <p className="text-sm text-gray-400">32 / 50</p>
        </div>
        <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
          <div className="h-full rounded-full bg-indigo-500" style={{ width: "64%" }} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {PLAN_CARDS.map((plan) => {
          const isCurrent = plan.id === currentPlan;
          const isCheckoutPlan = plan.id === "pro" || plan.id === "enterprise";
          const isLoading = checkoutLoadingPlan === plan.id;

          return (
            <div
              key={plan.id}
              className={`relative rounded-xl border p-6 ${
                plan.popular
                  ? "border-indigo-500/50 bg-gray-900 ring-1 ring-indigo-500/20"
                  : isCurrent
                    ? "border-gray-700 bg-gray-900"
                    : "border-gray-800 bg-gray-900"
              }`}
            >
              {plan.popular && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-3 py-0.5 text-xs font-medium">
                  Most Popular
                </span>
              )}

              <div className="mb-6">
                <h3 className="text-lg font-semibold">{plan.name}</h3>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-3xl font-bold">{plan.price}</span>
                  <span className="text-sm text-gray-400">/ {plan.period}</span>
                </div>
                <p className="mt-2 text-sm text-gray-400">{plan.description}</p>
              </div>

              <ul className="space-y-3 mb-8">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2 text-sm text-gray-300">
                    <svg
                      className="w-4 h-4 text-indigo-400 shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={2}
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>

              <button
                onClick={() => {
                  if (!organizationId || isCurrent || !isCheckoutPlan) return;
                  handleCheckout(plan.id === "pro" ? "pro" : "enterprise");
                }}
                disabled={!organizationId || isCurrent || !isCheckoutPlan || checkoutLoadingPlan !== null || portalLoading}
                className={`w-full rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${
                  isCurrent
                    ? "border border-gray-700 bg-gray-800 text-gray-500 cursor-not-allowed"
                    : plan.popular
                      ? "bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                      : "border border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-750 hover:border-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                }`}
              >
                {isLoading ? "Redirecting..." : getPlanActionLabel(plan.id, currentPlan)}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
