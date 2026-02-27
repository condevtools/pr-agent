import Stripe from "stripe";

export function getStripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return new Stripe(key, { apiVersion: "2025-02-24.acacia" });
}

export const PLANS = {
  free: {
    name: "Free",
    priceId: null,
    limits: { repos: 3, reviewsPerMonth: 50 },
  },
  pro: {
    name: "Pro",
    priceId: process.env.STRIPE_PRO_PRICE_ID,
    limits: { repos: Infinity, reviewsPerMonth: Infinity },
  },
  enterprise: {
    name: "Enterprise",
    priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID,
    limits: { repos: Infinity, reviewsPerMonth: Infinity },
  },
} as const;

export type PlanId = keyof typeof PLANS;
