import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getStripeClient, PLANS, type PlanId } from "@/lib/stripe";

interface CheckoutRequestBody {
  planId: "pro" | "enterprise";
  organizationId: string;
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as CheckoutRequestBody;
    const { planId, organizationId } = body;

    // Validate planId
    if (planId !== "pro" && planId !== "enterprise") {
      return NextResponse.json(
        { error: "Invalid planId. Must be 'pro' or 'enterprise'." },
        { status: 400 },
      );
    }

    if (!organizationId || typeof organizationId !== "string") {
      return NextResponse.json(
        { error: "organizationId is required." },
        { status: 400 },
      );
    }

    const plan = PLANS[planId as PlanId];
    if (!plan.priceId) {
      return NextResponse.json(
        { error: `No Stripe price configured for plan: ${planId}` },
        { status: 400 },
      );
    }

    const stripe = getStripeClient();

    const appUrl = process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: plan.priceId,
          quantity: 1,
        },
      ],
      metadata: {
        organizationId,
        planId,
      },
      success_url: `${appUrl}/dashboard/billing?success=true`,
      cancel_url: `${appUrl}/dashboard/billing?canceled=true`,
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (error) {
    console.error("[stripe/checkout] Error creating checkout session:", error);
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
