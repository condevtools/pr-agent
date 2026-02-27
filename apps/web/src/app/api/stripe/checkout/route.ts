import { NextRequest, NextResponse } from "next/server";
import { getStripeClient, PLANS, type PlanId } from "@/lib/stripe";

interface CheckoutRequestBody {
  planId: "pro" | "enterprise";
  tenantId: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as CheckoutRequestBody;
    const { planId, tenantId } = body;

    // Validate planId
    if (planId !== "pro" && planId !== "enterprise") {
      return NextResponse.json(
        { error: "Invalid planId. Must be 'pro' or 'enterprise'." },
        { status: 400 },
      );
    }

    if (!tenantId || typeof tenantId !== "string") {
      return NextResponse.json(
        { error: "tenantId is required." },
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
        tenantId,
        planId,
      },
      success_url: `${process.env.NEXTAUTH_URL ?? "http://localhost:3000"}/dashboard/billing?success=true`,
      cancel_url: `${process.env.NEXTAUTH_URL ?? "http://localhost:3000"}/dashboard/billing?canceled=true`,
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (error) {
    console.error("[stripe/checkout] Error creating checkout session:", error);
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
