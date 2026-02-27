import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripeClient } from "@/lib/stripe";

// ---------------------------------------------------------------------------
// Helpers – DB operations are optional (the handler works standalone)
// ---------------------------------------------------------------------------

type PlanValue = "free" | "pro" | "enterprise";
type SubscriptionStatusValue =
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "trialing"
  | "unpaid"
  | "paused";

/**
 * Attempt to lazily import the DB module.  Returns `null` when the package is
 * unavailable or the connection cannot be established so the webhook handler
 * can still acknowledge events and log them.
 */
async function tryGetDb() {
  try {
    const { getDefaultDb } = await import("@mr-agent/db");
    return getDefaultDb();
  } catch {
    console.warn(
      "[stripe/webhook] @mr-agent/db is not available – DB operations will be skipped.",
    );
    return null;
  }
}

async function tryGetSchema() {
  try {
    return await import("@mr-agent/db");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Map Stripe price IDs back to plan names
// ---------------------------------------------------------------------------

function resolvePlanFromPriceId(priceId: string): PlanValue {
  if (priceId === process.env.STRIPE_PRO_PRICE_ID) return "pro";
  if (priceId === process.env.STRIPE_ENTERPRISE_PRICE_ID) return "enterprise";
  console.warn(
    `[stripe/webhook] Unknown price ID "${priceId}" – defaulting to "free".`,
  );
  return "free";
}

function mapSubscriptionStatus(
  stripeStatus: string,
): SubscriptionStatusValue {
  const mapping: Record<string, SubscriptionStatusValue> = {
    active: "active",
    past_due: "past_due",
    canceled: "canceled",
    incomplete: "incomplete",
    trialing: "trialing",
    unpaid: "unpaid",
    paused: "paused",
  };
  return mapping[stripeStatus] ?? "incomplete";
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const tenantId = session.metadata?.tenantId;
  const planId = (session.metadata?.planId ?? "free") as PlanValue;
  const stripeCustomerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id;
  const stripeSubscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;

  if (!tenantId) {
    console.warn(
      "[stripe/webhook] checkout.session.completed missing tenantId in metadata",
    );
    return;
  }

  console.log(
    `[stripe/webhook] checkout.session.completed – tenant=${tenantId} plan=${planId}`,
  );

  const db = await tryGetDb();
  const schema = await tryGetSchema();

  if (!db || !schema) {
    console.warn(
      "[stripe/webhook] Skipping DB operations for checkout.session.completed",
    );
    return;
  }

  const { eq } = await import("drizzle-orm");

  // Update tenant with Stripe customer ID and plan
  await db
    .update(schema.tenants)
    .set({
      plan: planId,
      stripeCustomerId: stripeCustomerId ?? null,
      stripeSubscriptionId: stripeSubscriptionId ?? null,
    })
    .where(eq(schema.tenants.id, tenantId));

  // Create subscription record
  if (stripeSubscriptionId) {
    const stripe = getStripeClient();
    const subscription = await stripe.subscriptions.retrieve(
      stripeSubscriptionId,
    );

    await db.insert(schema.subscriptions).values({
      tenantId,
      stripeSubscriptionId,
      status: mapSubscriptionStatus(subscription.status),
      plan: planId,
      currentPeriodStart: new Date(
        subscription.current_period_start * 1000,
      ),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    });
  }
}

async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription,
) {
  const stripeSubscriptionId = subscription.id;
  const status = mapSubscriptionStatus(subscription.status);
  const priceId = subscription.items.data[0]?.price?.id;
  const plan = priceId ? resolvePlanFromPriceId(priceId) : undefined;

  console.log(
    `[stripe/webhook] customer.subscription.updated – sub=${stripeSubscriptionId} status=${status} plan=${plan ?? "unknown"}`,
  );

  const db = await tryGetDb();
  const schema = await tryGetSchema();

  if (!db || !schema) {
    console.warn(
      "[stripe/webhook] Skipping DB operations for customer.subscription.updated",
    );
    return;
  }

  const { eq } = await import("drizzle-orm");

  const updateData: Record<string, unknown> = {
    status,
    currentPeriodStart: new Date(
      subscription.current_period_start * 1000,
    ),
    currentPeriodEnd: new Date(subscription.current_period_end * 1000),
  };

  if (plan) {
    updateData.plan = plan;
  }

  await db
    .update(schema.subscriptions)
    .set(updateData)
    .where(
      eq(schema.subscriptions.stripeSubscriptionId, stripeSubscriptionId),
    );

  // Also update the tenant plan if the plan changed
  if (plan) {
    const subRow = await db
      .select({ tenantId: schema.subscriptions.tenantId })
      .from(schema.subscriptions)
      .where(
        eq(schema.subscriptions.stripeSubscriptionId, stripeSubscriptionId),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (subRow) {
      await db
        .update(schema.tenants)
        .set({ plan })
        .where(eq(schema.tenants.id, subRow.tenantId));
    }
  }
}

async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
) {
  const stripeSubscriptionId = subscription.id;

  console.log(
    `[stripe/webhook] customer.subscription.deleted – sub=${stripeSubscriptionId}`,
  );

  const db = await tryGetDb();
  const schema = await tryGetSchema();

  if (!db || !schema) {
    console.warn(
      "[stripe/webhook] Skipping DB operations for customer.subscription.deleted",
    );
    return;
  }

  const { eq } = await import("drizzle-orm");

  // Mark subscription as canceled
  await db
    .update(schema.subscriptions)
    .set({ status: "canceled" })
    .where(
      eq(schema.subscriptions.stripeSubscriptionId, stripeSubscriptionId),
    );

  // Downgrade tenant to free
  const subRow = await db
    .select({ tenantId: schema.subscriptions.tenantId })
    .from(schema.subscriptions)
    .where(
      eq(schema.subscriptions.stripeSubscriptionId, stripeSubscriptionId),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (subRow) {
    await db
      .update(schema.tenants)
      .set({ plan: "free", stripeSubscriptionId: null })
      .where(eq(schema.tenants.id, subRow.tenantId));
  }
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const stripeSubscriptionId =
    typeof invoice.subscription === "string"
      ? invoice.subscription
      : invoice.subscription?.id;

  if (!stripeSubscriptionId) {
    console.warn(
      "[stripe/webhook] invoice.payment_failed – no subscription ID on invoice",
    );
    return;
  }

  console.log(
    `[stripe/webhook] invoice.payment_failed – sub=${stripeSubscriptionId}`,
  );

  const db = await tryGetDb();
  const schema = await tryGetSchema();

  if (!db || !schema) {
    console.warn(
      "[stripe/webhook] Skipping DB operations for invoice.payment_failed",
    );
    return;
  }

  const { eq } = await import("drizzle-orm");

  await db
    .update(schema.subscriptions)
    .set({ status: "past_due" })
    .where(
      eq(schema.subscriptions.stripeSubscriptionId, stripeSubscriptionId),
    );
}

async function handleInvoicePaid(invoice: Stripe.Invoice) {
  const stripeSubscriptionId =
    typeof invoice.subscription === "string"
      ? invoice.subscription
      : invoice.subscription?.id;

  if (!stripeSubscriptionId) {
    console.warn(
      "[stripe/webhook] invoice.paid – no subscription ID on invoice",
    );
    return;
  }

  console.log(
    `[stripe/webhook] invoice.paid – sub=${stripeSubscriptionId}`,
  );

  const db = await tryGetDb();
  const schema = await tryGetSchema();

  if (!db || !schema) {
    console.warn(
      "[stripe/webhook] Skipping DB operations for invoice.paid",
    );
    return;
  }

  const { eq } = await import("drizzle-orm");

  await db
    .update(schema.subscriptions)
    .set({ status: "active" })
    .where(
      eq(schema.subscriptions.stripeSubscriptionId, stripeSubscriptionId),
    );
}

// ---------------------------------------------------------------------------
// POST /api/stripe/webhook
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[stripe/webhook] STRIPE_WEBHOOK_SECRET is not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 },
    );
  }

  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 },
    );
  }

  let event: Stripe.Event;

  try {
    const stripe = getStripeClient();
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[stripe/webhook] Signature verification failed: ${message}`);
    return NextResponse.json(
      { error: `Webhook signature verification failed: ${message}` },
      { status: 400 },
    );
  }

  console.log(
    `[stripe/webhook] Received event: ${event.type} (id=${event.id})`,
  );

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(
          event.data.object as Stripe.Checkout.Session,
        );
        break;

      case "customer.subscription.updated":
        await handleSubscriptionUpdated(
          event.data.object as Stripe.Subscription,
        );
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(
          event.data.object as Stripe.Subscription,
        );
        break;

      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      case "invoice.paid":
        await handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;

      default:
        console.log(`[stripe/webhook] Unhandled event type: ${event.type}`);
    }
  } catch (error) {
    console.error(
      `[stripe/webhook] Error processing event ${event.type}:`,
      error,
    );
    // Return 200 anyway to prevent Stripe from retrying—log the error for investigation
    return NextResponse.json({ received: true, error: "Processing error" });
  }

  return NextResponse.json({ received: true });
}
