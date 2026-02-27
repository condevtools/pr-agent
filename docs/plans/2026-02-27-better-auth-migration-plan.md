# Better Auth Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate from NextAuth v5 (beta) to Better Auth with the organization plugin, replacing hand-rolled Tenant/User/TenantMember models.

**Architecture:** Better Auth manages all auth/org tables via Prisma adapter. The `organization` table replaces `tenants`, `member` replaces `tenant_members`, and Better Auth's `user`/`account`/`session` replace the JWT-only setup. Business tables (Installation, AiConfig, UsageRecord, Subscription) keep their structure with foreign keys re-pointed to `organization`.

**Tech Stack:** Better Auth, Prisma (PostgreSQL), Next.js 15, pnpm monorepo with Turborepo

---

### Task 1: Install Better Auth and remove NextAuth

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml` (auto-updated)

**Step 1: Remove NextAuth and jose, add better-auth**

Run:
```bash
cd /Users/lemonade/Downloads/github/mr-agent
pnpm --filter @mr-agent/web remove next-auth jose
pnpm --filter @mr-agent/web add better-auth
```

**Step 2: Verify installation**

Run:
```bash
pnpm --filter @mr-agent/web list better-auth
```
Expected: `better-auth` version shown, `next-auth` and `jose` absent.

**Step 3: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore: replace next-auth with better-auth dependency"
```

---

### Task 2: Update Prisma schema — replace Tenant/User/TenantMember with Better Auth tables

**Files:**
- Modify: `packages/db/prisma/schema.prisma`

**Step 1: Rewrite the Prisma schema**

Replace the full contents of `packages/db/prisma/schema.prisma` with:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

enum Plan {
  free
  pro
  enterprise
}

enum MemberRole {
  owner
  admin
  member
}

enum InstallationStatus {
  active
  suspended
  removed
}

enum SubscriptionStatus {
  active
  past_due
  canceled
  trialing
}

// ---------------------------------------------------------------------------
// Better Auth core tables
// ---------------------------------------------------------------------------

model User {
  id            String    @id
  name          String
  email         String    @unique
  emailVerified Boolean   @default(false) @map("email_verified")
  image         String?
  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @updatedAt @map("updated_at")

  accounts Account[]
  sessions Session[]
  members  Member[]

  @@map("user")
}

model Account {
  id                    String    @id
  userId                String    @map("user_id")
  accountId             String    @map("account_id")
  providerId            String    @map("provider_id")
  accessToken           String?   @map("access_token")
  refreshToken          String?   @map("refresh_token")
  accessTokenExpiresAt  DateTime? @map("access_token_expires_at")
  refreshTokenExpiresAt DateTime? @map("refresh_token_expires_at")
  scope                 String?
  idToken               String?   @map("id_token")
  password              String?
  createdAt             DateTime  @default(now()) @map("created_at")
  updatedAt             DateTime  @updatedAt @map("updated_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("account")
}

model Session {
  id                     String    @id
  userId                 String    @map("user_id")
  token                  String    @unique
  expiresAt              DateTime  @map("expires_at")
  ipAddress              String?   @map("ip_address")
  userAgent              String?   @map("user_agent")
  activeOrganizationId   String?   @map("active_organization_id")
  createdAt              DateTime  @default(now()) @map("created_at")
  updatedAt              DateTime  @updatedAt @map("updated_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("session")
}

model Verification {
  id         String   @id
  identifier String
  value      String
  expiresAt  DateTime @map("expires_at")
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")

  @@map("verification")
}

// ---------------------------------------------------------------------------
// Better Auth organization plugin tables
// ---------------------------------------------------------------------------

model Organization {
  id                    String    @id
  name                  String
  slug                  String    @unique
  logo                  String?
  metadata              String?
  createdAt             DateTime  @default(now()) @map("created_at")

  // Business fields (additionalFields in Better Auth config)
  plan                  Plan      @default(free)
  stripeCustomerId      String?   @unique @map("stripe_customer_id")
  stripeSubscriptionId  String?   @unique @map("stripe_subscription_id")

  members        Member[]
  invitations    Invitation[]
  installations  Installation[]
  aiConfigs      AiConfig[]
  usageRecords   UsageRecord[]
  subscriptions  Subscription[]

  @@map("organization")
}

model Member {
  id             String   @id
  userId         String   @map("user_id")
  organizationId String   @map("organization_id")
  role           String   @default("member")
  createdAt      DateTime @default(now()) @map("created_at")

  user         User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@map("member")
}

model Invitation {
  id             String   @id
  email          String
  inviterId      String   @map("inviter_id")
  organizationId String   @map("organization_id")
  role           String   @default("member")
  status         String   @default("pending")
  expiresAt      DateTime @map("expires_at")
  createdAt      DateTime @default(now()) @map("created_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@map("invitation")
}

// ---------------------------------------------------------------------------
// Business tables (foreign keys re-pointed to Organization)
// ---------------------------------------------------------------------------

model Installation {
  id                    String             @id @default(uuid()) @db.Uuid
  organizationId        String             @map("organization_id")
  githubInstallationId  Int                @unique @map("github_installation_id")
  accountLogin          String             @map("account_login")
  accountType           String             @default("Organization") @map("account_type")
  status                InstallationStatus @default(active)
  createdAt             DateTime           @default(now()) @map("created_at")
  updatedAt             DateTime           @updatedAt @map("updated_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@map("installations")
}

model AiConfig {
  id               String   @id @default(uuid()) @db.Uuid
  organizationId   String   @map("organization_id")
  provider         String
  model            String
  apiKeyEncrypted  Bytes    @map("api_key_encrypted")
  apiKeyIv         Bytes    @map("api_key_iv")
  baseUrl          String?  @map("base_url")
  isActive         Boolean  @default(true) @map("is_active")
  createdAt        DateTime @default(now()) @map("created_at")
  updatedAt        DateTime @updatedAt @map("updated_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([organizationId, provider])
  @@map("ai_configs")
}

model UsageRecord {
  id             String   @id @default(uuid()) @db.Uuid
  organizationId String   @map("organization_id")
  eventType      String   @map("event_type")
  tokensIn       Int      @default(0) @map("tokens_in")
  tokensOut      Int      @default(0) @map("tokens_out")
  model          String
  createdAt      DateTime @default(now()) @map("created_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, createdAt])
  @@map("usage_records")
}

model Subscription {
  id                    String             @id @default(uuid()) @db.Uuid
  organizationId        String             @map("organization_id")
  stripeSubscriptionId  String             @unique @map("stripe_subscription_id")
  status                SubscriptionStatus
  plan                  Plan
  currentPeriodStart    DateTime?          @map("current_period_start")
  currentPeriodEnd      DateTime?          @map("current_period_end")
  createdAt             DateTime           @default(now()) @map("created_at")
  updatedAt             DateTime           @updatedAt @map("updated_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@map("subscriptions")
}
```

**Step 2: Generate Prisma client**

Run:
```bash
cd /Users/lemonade/Downloads/github/mr-agent
pnpm --filter @mr-agent/db db:generate
```
Expected: Prisma client generated without errors.

**Step 3: Commit**

```bash
git add packages/db/prisma/schema.prisma
git commit -m "schema: replace Tenant/User/TenantMember with Better Auth tables"
```

---

### Task 3: Rewrite Better Auth server config

**Files:**
- Rewrite: `apps/web/src/lib/auth.ts`

**Step 1: Rewrite auth.ts**

Replace the full contents of `apps/web/src/lib/auth.ts` with:

```ts
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
  },
  plugins: [
    organization({
      allowUserToCreateOrganization: true,
      schema: {
        organization: {
          additionalFields: {
            plan: { type: "string", defaultValue: "free", input: false },
            stripeCustomerId: { type: "string", required: false, input: false },
            stripeSubscriptionId: { type: "string", required: false, input: false },
          },
        },
      },
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
```

**Step 2: Commit**

```bash
git add apps/web/src/lib/auth.ts
git commit -m "feat: rewrite auth config with better-auth and organization plugin"
```

---

### Task 4: Create Better Auth client config

**Files:**
- Create: `apps/web/src/lib/auth-client.ts`

**Step 1: Create auth-client.ts**

Create `apps/web/src/lib/auth-client.ts`:

```ts
import { createAuthClient } from "better-auth/client";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [organizationClient()],
});
```

**Step 2: Commit**

```bash
git add apps/web/src/lib/auth-client.ts
git commit -m "feat: add better-auth client config with organization plugin"
```

---

### Task 5: Replace NextAuth route handler with Better Auth handler

**Files:**
- Delete: `apps/web/src/app/api/auth/[...nextauth]/route.ts`
- Create: `apps/web/src/app/api/auth/[...all]/route.ts`

**Step 1: Delete old NextAuth route handler**

```bash
rm -rf /Users/lemonade/Downloads/github/mr-agent/apps/web/src/app/api/auth/\[...nextauth\]
```

**Step 2: Create new Better Auth route handler**

Create directory and file `apps/web/src/app/api/auth/[...all]/route.ts`:

```ts
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const { GET, POST } = toNextJsHandler(auth);
```

**Step 3: Commit**

```bash
git add -A apps/web/src/app/api/auth/
git commit -m "feat: replace NextAuth route handler with better-auth handler"
```

---

### Task 6: Update dashboard layout to use Better Auth session

**Files:**
- Modify: `apps/web/src/app/dashboard/layout.tsx`

**Step 1: Update layout.tsx**

Replace the full contents of `apps/web/src/app/dashboard/layout.tsx` with:

```tsx
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { Sidebar } from "@/components/sidebar";
import { Header } from "@/components/header";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  if (!session) {
    redirect("/login");
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar - hidden on mobile, visible on lg+ */}
      <div className="hidden lg:flex">
        <Sidebar />
      </div>

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/web/src/app/dashboard/layout.tsx
git commit -m "feat: update dashboard layout to use better-auth session"
```

---

### Task 7: Update Stripe checkout route

**Files:**
- Modify: `apps/web/src/app/api/stripe/checkout/route.ts`

**Step 1: Update checkout/route.ts**

Replace the full contents of `apps/web/src/app/api/stripe/checkout/route.ts` with:

```ts
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
```

**Step 2: Commit**

```bash
git add apps/web/src/app/api/stripe/checkout/route.ts
git commit -m "feat: update stripe checkout route for better-auth and organization"
```

---

### Task 8: Update Stripe portal route

**Files:**
- Modify: `apps/web/src/app/api/stripe/portal/route.ts`

**Step 1: Update portal/route.ts**

Replace the full contents of `apps/web/src/app/api/stripe/portal/route.ts` with:

```ts
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
```

**Step 2: Commit**

```bash
git add apps/web/src/app/api/stripe/portal/route.ts
git commit -m "feat: update stripe portal route for better-auth and organization"
```

---

### Task 9: Update Stripe webhook route — tenant → organization

**Files:**
- Modify: `apps/web/src/app/api/stripe/webhook/route.ts`

**Step 1: Update webhook/route.ts**

Apply these changes to `apps/web/src/app/api/stripe/webhook/route.ts`:

1. In `handleCheckoutCompleted`: change `session.metadata?.tenantId` → `session.metadata?.organizationId`, change all `db.tenant.update` → `db.organization.update`, change subscription create `tenantId` → `organizationId`.
2. In `handleSubscriptionUpdated`: change `select: { tenantId: true }` → `select: { organizationId: true }`, change `subRow.tenantId` → `subRow.organizationId`, change `db.tenant.update` → `db.organization.update`.
3. In `handleSubscriptionDeleted`: same pattern as above.

Full replacement of `handleCheckoutCompleted`:

```ts
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

  const db = await tryGetDb();

  if (!db) {
    console.warn(
      "[stripe/webhook] Skipping DB operations for checkout.session.completed",
    );
    return;
  }

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

    await db.subscription.create({
      data: {
        organizationId,
        stripeSubscriptionId,
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
```

Full replacement of `handleSubscriptionUpdated`:

```ts
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

  if (!db) {
    console.warn(
      "[stripe/webhook] Skipping DB operations for customer.subscription.updated",
    );
    return;
  }

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

  await db.subscription.update({
    where: { stripeSubscriptionId },
    data: updateData,
  });

  // Also update the organization plan if the plan changed
  if (plan) {
    const subRow = await db.subscription.findUnique({
      where: { stripeSubscriptionId },
      select: { organizationId: true },
    });

    if (subRow) {
      await db.organization.update({
        where: { id: subRow.organizationId },
        data: { plan },
      });
    }
  }
}
```

Full replacement of `handleSubscriptionDeleted`:

```ts
async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
) {
  const stripeSubscriptionId = subscription.id;

  console.log(
    `[stripe/webhook] customer.subscription.deleted – sub=${stripeSubscriptionId}`,
  );

  const db = await tryGetDb();

  if (!db) {
    console.warn(
      "[stripe/webhook] Skipping DB operations for customer.subscription.deleted",
    );
    return;
  }

  // Mark subscription as canceled
  await db.subscription.update({
    where: { stripeSubscriptionId },
    data: { status: "canceled" },
  });

  // Downgrade organization to free
  const subRow = await db.subscription.findUnique({
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
```

The `handleInvoicePaymentFailed`, `handleInvoicePaid`, and the main `POST` handler remain unchanged (they only operate on `subscription` table which already uses `stripeSubscriptionId` as the key).

**Step 2: Commit**

```bash
git add apps/web/src/app/api/stripe/webhook/route.ts
git commit -m "feat: update stripe webhook to use organization instead of tenant"
```

---

### Task 10: Update tenant-resolver to use organization

**Files:**
- Modify: `packages/db/src/tenant-resolver.ts`

**Step 1: Update tenant-resolver.ts**

Replace the full contents of `packages/db/src/tenant-resolver.ts` with:

```ts
import type { PrismaClient } from "@prisma/client";
import { decryptApiKey } from "./crypto.js";

/** Resolved organization context used throughout the request lifecycle. */
export interface TenantConfig {
  tenantId: string;
  plan: "free" | "pro" | "enterprise";
  ai: {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl?: string;
  };
}

/**
 * Resolve a full {@link TenantConfig} from a GitHub App installation ID.
 *
 * This is the primary entry point for multi-tenant request routing:
 *   installation_id  ->  installations row  ->  organization  ->  active ai_config
 *
 * If the installation is not found, the organization does not exist, or there is
 * no active AI configuration, the function returns `null` so that callers
 * can fall back to the legacy env-var-based behaviour.
 *
 * @param db             - Prisma database client.
 * @param installationId - GitHub App installation ID (numeric).
 */
export async function resolveTenantFromInstallation(
  db: PrismaClient,
  installationId: number,
): Promise<TenantConfig | null> {
  const installation = await db.installation.findUnique({
    where: {
      githubInstallationId: installationId,
    },
    include: {
      organization: {
        include: {
          aiConfigs: {
            where: { isActive: true },
            take: 1,
          },
        },
      },
    },
  });

  if (!installation || installation.status !== "active") return null;

  const { organization } = installation;
  const aiConfig = organization.aiConfigs[0];

  if (!aiConfig) return null;

  return {
    tenantId: organization.id,
    plan: organization.plan,
    ai: {
      provider: aiConfig.provider,
      model: aiConfig.model,
      apiKey: decryptApiKey(
        Buffer.from(aiConfig.apiKeyEncrypted),
        Buffer.from(aiConfig.apiKeyIv),
      ),
      baseUrl: aiConfig.baseUrl ?? undefined,
    },
  };
}
```

Note: The `TenantConfig` interface and `resolveTenantFromInstallation` function name are kept unchanged to avoid cascading changes in downstream consumers. The `tenantId` field is retained as the field name to avoid churn in `subscription-gate.ts` and `tenant-concurrency.ts`.

**Step 2: Commit**

```bash
git add packages/db/src/tenant-resolver.ts
git commit -m "feat: update tenant-resolver to query organization instead of tenant"
```

---

### Task 11: Update login page to use Better Auth client

**Files:**
- Modify: `apps/web/src/app/login/page.tsx`

**Step 1: Update login/page.tsx**

Replace the full contents of `apps/web/src/app/login/page.tsx` with:

```tsx
"use client";

import Link from "next/link";
import { authClient } from "@/lib/auth-client";

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link href="/" className="text-2xl font-bold tracking-tight">
            <span className="text-indigo-400">MR</span> Agent
          </Link>
          <p className="mt-2 text-gray-400">Sign in to manage your AI code reviews</p>
        </div>

        <div className="rounded-xl border border-gray-800 bg-gray-900 p-8">
          <h2 className="text-xl font-semibold text-center mb-6">Welcome back</h2>

          <button
            onClick={() => {
              authClient.signIn.social({ provider: "github" });
            }}
            className="w-full flex items-center justify-center gap-3 rounded-lg bg-gray-800 border border-gray-700 px-4 py-3 text-sm font-medium hover:bg-gray-750 hover:border-gray-600 transition-colors"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            Sign in with GitHub
          </button>

          <div className="mt-6 text-center">
            <p className="text-xs text-gray-500">
              By signing in, you agree to our{" "}
              <a href="#" className="text-indigo-400 hover:text-indigo-300">
                Terms of Service
              </a>{" "}
              and{" "}
              <a href="#" className="text-indigo-400 hover:text-indigo-300">
                Privacy Policy
              </a>
              .
            </p>
          </div>
        </div>

        <p className="mt-6 text-center text-sm text-gray-500">
          Don&apos;t have an account?{" "}
          <a href="#" className="text-indigo-400 hover:text-indigo-300">
            Request access
          </a>
        </p>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/web/src/app/login/page.tsx
git commit -m "feat: update login page to use better-auth client signIn"
```

---

### Task 12: Update header component sign-out

**Files:**
- Modify: `apps/web/src/components/header.tsx`

**Step 1: Update header.tsx**

In `apps/web/src/components/header.tsx`:

1. Add import at the top (after existing imports):
```ts
import { authClient } from "@/lib/auth-client";
```

2. Replace the sign-out button onClick handler (line 60-63):

Old:
```tsx
onClick={() => {
  // In production: signOut()
  window.location.href = "/";
}}
```

New:
```tsx
onClick={() => {
  authClient.signOut({ fetchOptions: { onSuccess: () => { window.location.href = "/"; } } });
}}
```

**Step 2: Commit**

```bash
git add apps/web/src/components/header.tsx
git commit -m "feat: update header sign-out to use better-auth client"
```

---

### Task 13: Type-check and verify build

**Files:** None (verification only)

**Step 1: Run TypeScript check**

```bash
cd /Users/lemonade/Downloads/github/mr-agent
pnpm check
```

Expected: No type errors. If there are errors, fix them before continuing.

**Step 2: Verify web build compiles**

```bash
pnpm --filter @mr-agent/web build
```

Expected: Build succeeds.

**Step 3: Commit any fixes**

If any fixes were needed:
```bash
git add -A
git commit -m "fix: resolve type errors from better-auth migration"
```

---

### Task 14: Final cleanup — remove stale references

**Files:**
- Potentially modify: any file still referencing `NEXTAUTH_URL`

**Step 1: Search for remaining NextAuth references**

Search the codebase for any remaining references to `next-auth`, `NextAuth`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`:

```bash
cd /Users/lemonade/Downloads/github/mr-agent
grep -r "next-auth\|NextAuth\|NEXTAUTH" --include="*.ts" --include="*.tsx" --include="*.json" --include="*.yaml" --include="*.yml" apps/ packages/ k8s/ 2>/dev/null | grep -v node_modules | grep -v .next
```

Expected: No results (all references already replaced in previous tasks).

**Step 2: If any stale references found, update them**

Replace `NEXTAUTH_URL` with `BETTER_AUTH_URL` and `NEXTAUTH_SECRET` with `BETTER_AUTH_SECRET` in any remaining files.

**Step 3: Commit if changes were made**

```bash
git add -A
git commit -m "chore: remove remaining NextAuth references"
```
