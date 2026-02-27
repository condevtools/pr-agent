import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getStripeClient } from "@/lib/stripe";
import {
  canManageBilling,
  getBillingOrganizationMembership,
} from "@/lib/organization-billing";
import { resolveAppUrl } from "@/lib/env";

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
    const membership = await getBillingOrganizationMembership({
      userId: session.user.id,
      organizationId,
    });
    if (!membership) {
      return NextResponse.json(
        { error: "You are not a member of the target organization." },
        { status: 403 },
      );
    }
    if (!canManageBilling(membership.role)) {
      return NextResponse.json(
        { error: "Only organization owners/admins can manage billing." },
        { status: 403 },
      );
    }

    const stripeCustomerId = membership.stripeCustomerId;

    if (!stripeCustomerId) {
      return NextResponse.json(
        { error: "No Stripe customer found for this organization. Please subscribe to a plan first." },
        { status: 404 },
      );
    }

    const stripe = getStripeClient();

    const appUrl = resolveAppUrl();

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
