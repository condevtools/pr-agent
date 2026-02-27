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
  | "trialing";

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

// ---------------------------------------------------------------------------
// Event deduplication
// ---------------------------------------------------------------------------

/**
 * Check if this Stripe event has already been processed.
 * Returns `true` if the event was already processed (should skip).
 */
async function isEventAlreadyProcessed(
  db: NonNullable<Awaited<ReturnType<typeof tryGetDb>>>,
  eventId: string,
): Promise<boolean> {
  try {
    const existing = await db.processedWebhookEvent.findUnique({
      where: { eventId },
      select: { eventId: true },
    });
    return existing != null;
  } catch {
    // If dedup table doesn't exist yet (pre-migration), allow through
    return false;
  }
}

/**
 * Record that a Stripe event has been successfully processed.
 */
async function markEventProcessed(
  db: NonNullable<Awaited<ReturnType<typeof tryGetDb>>>,
  eventId: string,
  eventType: string,
): Promise<void> {
  try {
    await db.processedWebhookEvent.create({
      data: { eventId, eventType },
    });
  } catch {
    // Unique constraint violation means another worker processed it first — fine
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
    trialing: "trialing",
  };
  return mapping[stripeStatus] ?? "canceled";
}

// ---------------------------------------------------------------------------
// Transient error detection – return 500 so Stripe retries
// ---------------------------------------------------------------------------

function isTransientError(error: unknown): boolean {
  if (error != null && typeof error === "object") {
    // Prisma connection error codes
    const code = (error as { code?: string }).code;
    if (
      code === "P1001" ||
      code === "P1002" ||
      code === "P1008" ||
      code === "P1017"
    ) {
      return true;
    }

    const message =
      (error as { message?: string }).message ?? "";
    if (
      message.includes("ECONNREFUSED") ||
      message.includes("ETIMEDOUT") ||
      message.includes("ECONNRESET")
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const organizationId = session.metadata?.organizationId;
  const planId = (session.metadata?.planId ?? "free") as PlanValue;
  const stripeCustomerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id;
  const stripeSubscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;

  if (!organizationId) {
    console.warn(
      "[stripe/webhook] checkout.session.completed missing organizationId in metadata",
    );
    return;
  }

  console.log(
    `[stripe/webhook] checkout.session.completed – org=${organizationId} plan=${planId}`,
  );

  const db = await requireDb("checkout.session.completed");
  if (!db) return;

  // Update organization with Stripe customer ID and plan
  await db.organization.update({
    where: { id: organizationId },
    data: {
      plan: planId,
      stripeCustomerId: stripeCustomerId ?? null,
      stripeSubscriptionId: stripeSubscriptionId ?? null,
    },
  });

  // Create subscription record
  if (stripeSubscriptionId) {
    const stripe = getStripeClient();
    const subscription = await stripe.subscriptions.retrieve(
      stripeSubscriptionId,
    );

    await db.subscription.upsert({
      where: { stripeSubscriptionId },
      create: {
        organizationId,
        stripeSubscriptionId,
        status: mapSubscriptionStatus(subscription.status),
        plan: planId,
        currentPeriodStart: new Date(
          subscription.current_period_start * 1000,
        ),
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      },
      update: {
        organizationId,
        status: mapSubscriptionStatus(subscription.status),
        plan: planId,
        currentPeriodStart: new Date(
          subscription.current_period_start * 1000,
        ),
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      },
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

  const db = await requireDb("customer.subscription.updated");
  if (!db) return;

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

  // Resolve organizationId: first try existing sub, then fallback via stripeCustomerId
  const existingSub = await db.subscription.findUnique({
    where: { stripeSubscriptionId },
    select: { organizationId: true },
  });

  let organizationId = existingSub?.organizationId;

  if (!organizationId) {
    const stripeCustomerId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer?.id;

    if (stripeCustomerId) {
      const org = await db.organization.findFirst({
        where: { stripeCustomerId },
        select: { id: true },
      });
      organizationId = org?.id;
    }
  }

  if (!organizationId) {
    console.warn(
      `[stripe/webhook] customer.subscription.updated – cannot resolve org for sub=${stripeSubscriptionId}`,
    );
    return;
  }

  await db.subscription.upsert({
    where: { stripeSubscriptionId },
    create: {
      organizationId,
      stripeSubscriptionId,
      status,
      plan: plan ?? "free",
      currentPeriodStart: new Date(
        subscription.current_period_start * 1000,
      ),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    },
    update: updateData,
  });

  // Also update the organization plan if the plan changed
  if (plan) {
    await db.organization.update({
      where: { id: organizationId },
      data: { plan },
    });
  }
}

async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
) {
  const stripeSubscriptionId = subscription.id;

  console.log(
    `[stripe/webhook] customer.subscription.deleted – sub=${stripeSubscriptionId}`,
  );

  const db = await requireDb("customer.subscription.deleted");
  if (!db) return;

  // Mark subscription as canceled (updateMany silently handles missing record)
  await db.subscription.updateMany({
    where: { stripeSubscriptionId },
    data: { status: "canceled" },
  });

  // Downgrade organization to free
  const subRow = await db.subscription.findFirst({
    where: { stripeSubscriptionId },
    select: { organizationId: true },
  });

  if (subRow) {
    await db.organization.update({
      where: { id: subRow.organizationId },
      data: { plan: "free", stripeSubscriptionId: null },
    });
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

  const db = await requireDb("invoice.payment_failed");
  if (!db) return;

  await db.subscription.updateMany({
    where: { stripeSubscriptionId },
    data: { status: "past_due" },
  });
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

  const db = await requireDb("invoice.paid");
  if (!db) return;

  await db.subscription.updateMany({
    where: { stripeSubscriptionId },
    data: { status: "active" },
  });
}

// ---------------------------------------------------------------------------
// DB availability helper
// ---------------------------------------------------------------------------

/**
 * When DATABASE_URL is set but tryGetDb() returns null, the DB is expected
 * but unavailable — throw so the caller returns 500 and Stripe retries.
 * When DATABASE_URL is not set, DB operations are truly optional.
 */
async function requireDb(eventType: string) {
  const db = await tryGetDb();
  if (db) return db;

  if (process.env.DATABASE_URL) {
    throw new Error(
      `[stripe/webhook] DATABASE_URL is set but DB is unavailable for ${eventType} — returning 500 for Stripe retry`,
    );
  }

  console.warn(
    `[stripe/webhook] Skipping DB operations for ${eventType} (no DATABASE_URL)`,
  );
  return null;
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
      { error: "Webhook signature verification failed" },
      { status: 400 },
    );
  }

  console.log(
    `[stripe/webhook] Received event: ${event.type} (id=${event.id})`,
  );

  // Dedup check: skip if this event was already processed
  const db = await tryGetDb();
  if (db) {
    if (await isEventAlreadyProcessed(db, event.id)) {
      console.log(
        `[stripe/webhook] Skipping duplicate event: ${event.type} (id=${event.id})`,
      );
      return NextResponse.json({ received: true, deduplicated: true });
    }
  }

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

    // Record successful processing for dedup
    if (db) {
      await markEventProcessed(db, event.id, event.type);
    }
  } catch (error) {
    console.error(
      `[stripe/webhook] Error processing event ${event.type}:`,
      error,
    );

    // Transient errors (DB connection, network) → 500 so Stripe retries
    if (isTransientError(error)) {
      return NextResponse.json(
        { received: true, error: "Transient processing error" },
        { status: 500 },
      );
    }

    // Permanent errors → 200 to prevent infinite retries
    return NextResponse.json({ received: true, error: "Processing error" });
  }

  return NextResponse.json({ received: true });
}
