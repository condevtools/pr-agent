import { NextRequest, NextResponse } from "next/server";
import { getStripeClient } from "@/lib/stripe";

interface PortalRequestBody {
  tenantId: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as PortalRequestBody;
    const { tenantId } = body;

    if (!tenantId || typeof tenantId !== "string") {
      return NextResponse.json(
        { error: "tenantId is required." },
        { status: 400 },
      );
    }

    // Look up the tenant's Stripe customer ID from the database
    let stripeCustomerId: string | null = null;

    try {
      const { getDefaultDb, tenants } = await import("@mr-agent/db");
      const { eq } = await import("drizzle-orm");

      const db = getDefaultDb();
      if (!db) throw new Error("Database not available");
      const tenantRow = await db
        .select({ stripeCustomerId: tenants.stripeCustomerId })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      stripeCustomerId = tenantRow?.stripeCustomerId ?? null;
    } catch {
      console.warn(
        "[stripe/portal] Could not query database for tenant Stripe customer ID",
      );
    }

    if (!stripeCustomerId) {
      return NextResponse.json(
        { error: "No Stripe customer found for this tenant. Please subscribe to a plan first." },
        { status: 404 },
      );
    }

    const stripe = getStripeClient();

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${process.env.NEXTAUTH_URL ?? "http://localhost:3000"}/dashboard/billing`,
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (error) {
    console.error("[stripe/portal] Error creating portal session:", error);
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
