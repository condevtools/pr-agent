import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getStripeClient } from "@/lib/stripe";

interface PortalRequestBody {
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

    const body = (await request.json()) as PortalRequestBody;
    const { organizationId } = body;

    if (!organizationId || typeof organizationId !== "string") {
      return NextResponse.json(
        { error: "organizationId is required." },
        { status: 400 },
      );
    }

    // Look up the organization's Stripe customer ID from the database
    let stripeCustomerId: string | null = null;

    try {
      const { getDefaultDb } = await import("@mr-agent/db");

      const db = getDefaultDb();
      if (!db) throw new Error("Database not available");

      const orgRow = await db.organization.findUnique({
        where: { id: organizationId },
        select: { stripeCustomerId: true },
      });

      stripeCustomerId = orgRow?.stripeCustomerId ?? null;
    } catch {
      console.warn(
        "[stripe/portal] Could not query database for organization Stripe customer ID",
      );
    }

    if (!stripeCustomerId) {
      return NextResponse.json(
        { error: "No Stripe customer found for this organization. Please subscribe to a plan first." },
        { status: 404 },
      );
    }

    const stripe = getStripeClient();

    const appUrl = process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${appUrl}/dashboard/billing`,
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (error) {
    console.error("[stripe/portal] Error creating portal session:", error);
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
