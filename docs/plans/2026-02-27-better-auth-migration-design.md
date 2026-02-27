# Better Auth Migration Design

## Overview

Migrate from NextAuth v5 (beta) to Better Auth with the organization plugin, replacing the hand-rolled Tenant/TenantMember/User models with Better Auth's built-in user/organization/member system.

## Motivation

- NextAuth (Auth.js) is in maintenance mode; the team has joined Better Auth (Sept 2025)
- Current auth layer uses beta NextAuth v5 with type hacks (`(session as any).userId`)
- No server-side validation that authenticated users belong to the requested tenant
- Hand-rolled tenant membership lacks invitation system, RBAC, and organization switching
- Better Auth's organization plugin provides all of the above out of the box

## Approach: Full Replacement (Option A)

Better Auth generates and manages all auth/org tables. Existing `Tenant`/`User`/`TenantMember` tables are replaced by Better Auth's `organization`/`user`/`member` tables. Business tables (`Installation`, `AiConfig`, `UsageRecord`, `Subscription`) retain their structure with foreign keys re-pointed.

## Database Schema Changes

### Table Mapping

| Current Table | Better Auth Replacement | Notes |
|--------------|------------------------|-------|
| `users` | `user` | Better Auth manages; GitHub identity stored in `account` table |
| `tenants` | `organization` | Extended with `plan`, `stripeCustomerId`, `stripeSubscriptionId` via additionalFields |
| `tenant_members` | `member` | Built-in role field, invitation support |
| _(none)_ | `session` | DB-backed sessions replace JWT cookies; includes `activeOrganizationId` |
| _(none)_ | `account` | OAuth provider account linkage (GitHub tokens, etc.) |
| _(none)_ | `verification` | Email verification tokens |
| _(none)_ | `invitation` | Built-in invitation system with email, expiration, status |

### Organization Additional Fields

```ts
organization({
  schema: {
    organization: {
      additionalFields: {
        plan: { type: "string", defaultValue: "free" },
        stripeCustomerId: { type: "string", required: false },
        stripeSubscriptionId: { type: "string", required: false },
      },
    },
  },
})
```

### Foreign Key Changes

Tables that reference `tenantId` will be updated to reference `organizationId`:
- `installations.tenant_id` → `installations.organization_id`
- `ai_configs.tenant_id` → `ai_configs.organization_id`
- `usage_records.tenant_id` → `usage_records.organization_id`
- `subscriptions.tenant_id` → `subscriptions.organization_id`

### Enums Retained

- `Plan` (free/pro/enterprise)
- `MemberRole` (owner/admin/member) — may align with Better Auth's built-in roles
- `InstallationStatus` (active/suspended/removed)
- `SubscriptionStatus` (active/past_due/canceled/trialing)

## Auth Configuration

### Server Config (`apps/web/src/lib/auth.ts`)

Complete rewrite using Better Auth:

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
            plan: { type: "string", defaultValue: "free" },
            stripeCustomerId: { type: "string", required: false },
            stripeSubscriptionId: { type: "string", required: false },
          },
        },
      },
    }),
  ],
});
```

### Client Config (`apps/web/src/lib/auth-client.ts`)

New file:

```ts
import { createAuthClient } from "better-auth/client";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [organizationClient()],
});
```

### Route Handler

Path change: `api/auth/[...nextauth]/route.ts` → `api/auth/[...all]/route.ts`

```ts
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const { GET, POST } = toNextJsHandler(auth);
```

## Code Changes

### Session Access Pattern

All `auth()` calls change to `auth.api.getSession({ headers })`:

| File | Before | After |
|------|--------|-------|
| `dashboard/layout.tsx` | `await auth()` | `await auth.api.getSession({ headers: await headers() })` |
| `stripe/checkout/route.ts` | `await auth()` | `await auth.api.getSession({ headers: request.headers })` |
| `stripe/portal/route.ts` | `await auth()` | `await auth.api.getSession({ headers: request.headers })` |

### Client-Side Auth

| File | Before | After |
|------|--------|-------|
| `login/page.tsx` | `window.location.href = "/api/auth/signin"` | `authClient.signIn.social({ provider: "github" })` |
| `header.tsx` | `window.location.href = "/"` | `authClient.signOut()` |

### Backend Tenant Resolution

`packages/db/src/tenant-resolver.ts`: All `tenant` references → `organization`:

```ts
// Before
const installation = await db.installation.findUnique({
  where: { githubInstallationId: installationId },
  include: { tenant: { include: { aiConfigs: ... } } },
});

// After
const installation = await db.installation.findUnique({
  where: { githubInstallationId: installationId },
  include: { organization: { include: { aiConfigs: ... } } },
});
```

### Stripe Routes

- `NEXTAUTH_URL` env var references → `BETTER_AUTH_URL`
- `metadata.tenantId` in checkout → `metadata.organizationId`
- Webhook handler: tenant lookup by `organizationId`

## Dependency Changes

### `apps/web/package.json`

| Remove | Add |
|--------|-----|
| `next-auth` | `better-auth` |
| `jose` | — |

### Environment Variables

| Remove | Add |
|--------|-----|
| `NEXTAUTH_URL` | `BETTER_AUTH_URL` |
| `NEXTAUTH_SECRET` | `BETTER_AUTH_SECRET` |

## Files Affected

### Delete
- `apps/web/src/app/api/auth/[...nextauth]/route.ts`

### Create
- `apps/web/src/app/api/auth/[...all]/route.ts`
- `apps/web/src/lib/auth-client.ts`

### Rewrite
- `apps/web/src/lib/auth.ts`

### Modify
- `apps/web/package.json`
- `apps/web/src/app/dashboard/layout.tsx`
- `apps/web/src/app/api/stripe/checkout/route.ts`
- `apps/web/src/app/api/stripe/portal/route.ts`
- `apps/web/src/app/api/stripe/webhook/route.ts`
- `apps/web/src/app/login/page.tsx`
- `apps/web/src/components/header.tsx`
- `packages/db/prisma/schema.prisma`
- `packages/db/src/tenant-resolver.ts`
- `packages/db/src/client.ts`
- `packages/db/src/index.ts`
- `apps/api/src/middleware/subscription-gate.ts`
- `packages/review/src/tenant-concurrency.ts`

## Personal + Organization Mode

Better Auth's organization plugin natively supports both:
- **Personal mode**: `activeOrganizationId = null` — user operates independently
- **Organization mode**: user sets an active organization and data is scoped to it
- `<OrganizationSwitcher />` UI component for seamless switching

## Risk & Mitigation

| Risk | Mitigation |
|------|-----------|
| Database migration breaks existing data | Generate Prisma migration, test against dev DB first |
| Session format change logs out all users | Expected and acceptable — one-time event |
| Better Auth API differences from NextAuth | Auth surface is small (8 files), all changes are mapped above |
| Organization plugin schema doesn't match Tenant fields exactly | Using `additionalFields` to extend organization table |
