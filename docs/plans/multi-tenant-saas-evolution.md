# Multi-Tenant SaaS Evolution Plan

> Date: 2026-02-27
> Status: Planning
> Branch: `feat/multi-tenant-saas`

## Goal

Transform mr-agent from a single-tenant self-hosted webhook service into a multi-tenant SaaS platform where:

1. Users install the GitHub App and configure their AI provider via a web dashboard
2. Users can bring their own API keys (BYO-Key) or pay for platform-hosted AI
3. The platform supports multiple concurrent tenants with isolated configurations
4. Billing via Stripe for paid tiers
5. Deployable on Kubernetes for horizontal scaling

---

## Phase 0 — Monorepo Restructure

**Goal:** Reorganize the codebase into a pnpm monorepo without changing any business logic.

### Target Structure

```
mr-agent/
├── packages/
│   ├── core/                    # Shared infrastructure (from src/core/)
│   │   ├── src/
│   │   │   ├── ask-session.ts
│   │   │   ├── cache.ts
│   │   │   ├── clock.ts
│   │   │   ├── dedupe.ts
│   │   │   ├── env.ts
│   │   │   ├── errors.ts
│   │   │   ├── fnv.ts
│   │   │   ├── http.ts
│   │   │   ├── i18n.ts
│   │   │   ├── logger.ts
│   │   │   ├── path.ts
│   │   │   ├── rate-limit.ts
│   │   │   ├── runtime-state.ts
│   │   │   ├── runtime-state-*.ts
│   │   │   ├── secret-patterns.ts
│   │   │   └── index.ts
│   │   ├── package.json          # @mr-agent/core
│   │   └── tsconfig.json
│   │
│   ├── review/                   # AI review engine (from src/review/)
│   │   ├── src/
│   │   │   ├── ai-reviewer.ts
│   │   │   ├── ai-prompts.ts
│   │   │   ├── ai-concurrency.ts
│   │   │   ├── ai-client-cache.ts
│   │   │   ├── ai-provider-*.ts
│   │   │   ├── patch.ts
│   │   │   ├── report-renderer.ts
│   │   │   ├── review-*.ts
│   │   │   ├── similar-issue.ts
│   │   │   └── index.ts
│   │   ├── package.json          # @mr-agent/review
│   │   └── tsconfig.json
│   │
│   ├── shared/                   # Cross-platform integration utils (from src/integrations/shared/)
│   │   ├── src/
│   │   │   ├── command-*.ts
│   │   │   ├── managed-comments.ts
│   │   │   ├── review-*.ts
│   │   │   ├── feedback-signals.ts
│   │   │   ├── secret-*.ts
│   │   │   ├── auto-labels.ts
│   │   │   ├── similar-issue.ts
│   │   │   ├── changelog.ts
│   │   │   ├── describe-question.ts
│   │   │   ├── diff-context.ts
│   │   │   ├── process-guidelines.ts
│   │   │   ├── yaml.ts
│   │   │   └── index.ts
│   │   ├── package.json          # @mr-agent/shared
│   │   └── tsconfig.json
│   │
│   └── db/                       # Database layer (new in Phase 1)
│       ├── src/
│       │   ├── schema.ts         # Prisma/Drizzle schema
│       │   ├── client.ts
│       │   └── index.ts
│       ├── migrations/
│       ├── package.json          # @mr-agent/db
│       └── tsconfig.json
│
├── apps/
│   ├── github-app/               # NestJS webhook server (from src/)
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── app.controller.ts
│   │   │   ├── app.ts
│   │   │   ├── integrations/
│   │   │   │   ├── github/       # GitHub-specific integration
│   │   │   │   ├── gitlab/       # GitLab-specific integration
│   │   │   │   └── notify/       # Notification webhooks
│   │   │   ├── modules/          # NestJS modules
│   │   │   └── common/           # Filters, types
│   │   ├── tests/
│   │   ├── package.json          # @mr-agent/github-app
│   │   └── tsconfig.json
│   │
│   └── web/                      # Frontend dashboard (new in Phase 2)
│       ├── src/
│       │   ├── app/              # Next.js App Router
│       │   ├── components/
│       │   └── lib/
│       ├── package.json          # @mr-agent/web
│       └── tsconfig.json
│
├── pnpm-workspace.yaml
├── turbo.json
├── package.json                  # Root workspace
├── tsconfig.base.json            # Shared TS config
├── Dockerfile                    # Multi-stage (builds all packages + github-app)
├── docker-compose.yml
└── .env.example
```

### Steps

1. Initialize pnpm workspace + turborepo config
2. Create `tsconfig.base.json` with shared compiler options
3. Move `src/core/` → `packages/core/src/`
4. Move `src/review/` → `packages/review/src/`
5. Move `src/integrations/shared/` → `packages/shared/src/`
6. Move remaining `src/` → `apps/github-app/src/`
7. Move `tests/` → `apps/github-app/tests/`
8. Replace `#core`, `#review`, `#integrations/*` subpath imports with `@mr-agent/core`, `@mr-agent/review`, `@mr-agent/shared`
9. Create per-package `package.json` with correct dependencies
10. Update `Dockerfile` for monorepo build
11. Update `docker-compose.yml`
12. Verify: `pnpm install && pnpm build && pnpm test`

### Dependency Graph

```
@mr-agent/core          ← no internal deps
@mr-agent/review        ← depends on @mr-agent/core
@mr-agent/shared        ← depends on @mr-agent/core, @mr-agent/review
@mr-agent/github-app    ← depends on @mr-agent/core, @mr-agent/review, @mr-agent/shared
@mr-agent/db            ← depends on @mr-agent/core (Phase 1)
@mr-agent/web           ← depends on @mr-agent/db (Phase 2)
```

### Risk

- **Low risk**: Pure structural refactor, no logic changes
- **Key verification**: All 177 tests must pass after restructure

---

## Phase 1 — Database + Tenant Data Model

**Goal:** Introduce PostgreSQL + Drizzle ORM with a proper tenant/user/installation data model.

### Why Drizzle over Prisma

- Pure TypeScript, no codegen binary
- Better ESM support (project is pure ESM)
- Lighter weight, fits the project's minimal-dependency philosophy
- Direct SQL access when needed

### Schema Design

```sql
-- Tenants (organizations/individuals that install the GitHub App)
CREATE TABLE tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  plan          TEXT NOT NULL DEFAULT 'free',       -- free | pro | enterprise
  stripe_customer_id  TEXT,
  stripe_subscription_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Users (GitHub accounts linked to tenants)
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id     INTEGER NOT NULL UNIQUE,
  github_login  TEXT NOT NULL,
  email         TEXT,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tenant membership
CREATE TABLE tenant_members (
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member',     -- owner | admin | member
  PRIMARY KEY (tenant_id, user_id)
);

-- GitHub App installations → tenant mapping
CREATE TABLE installations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  github_installation_id  INTEGER NOT NULL UNIQUE,
  account_login     TEXT NOT NULL,                  -- org or user login
  account_type      TEXT NOT NULL DEFAULT 'Organization', -- Organization | User
  status            TEXT NOT NULL DEFAULT 'active', -- active | suspended | removed
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-tenant AI provider configuration
CREATE TABLE ai_configs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,                     -- openai | openai-compatible | anthropic | gemini
  model         TEXT NOT NULL,
  api_key_encrypted  BYTEA NOT NULL,               -- AES-256-GCM encrypted
  api_key_iv    BYTEA NOT NULL,
  base_url      TEXT,                              -- for openai-compatible
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)                     -- one config per provider per tenant
);

-- Usage tracking (for billing)
CREATE TABLE usage_records (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,                     -- review | ask | describe | changelog | ...
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  model         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_tenant_date ON usage_records(tenant_id, created_at);

-- Subscriptions (Stripe-managed, local cache)
CREATE TABLE subscriptions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  status                TEXT NOT NULL,             -- active | past_due | canceled | trialing
  plan                  TEXT NOT NULL,             -- free | pro | enterprise
  current_period_start  TIMESTAMPTZ,
  current_period_end    TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### API Key Encryption

```typescript
// packages/db/src/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
// DB_ENCRYPTION_KEY from env — 32-byte hex string
const getKey = () => Buffer.from(process.env.DB_ENCRYPTION_KEY!, "hex");

export function encryptApiKey(plaintext: string): { encrypted: Buffer; iv: Buffer } {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { encrypted, iv };
}

export function decryptApiKey(encrypted: Buffer, iv: Buffer): string {
  const authTag = encrypted.subarray(-16);
  const ciphertext = encrypted.subarray(0, -16);
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext, undefined, "utf8") + decipher.final("utf8");
}
```

### Tenant Resolution in Webhook Flow

```typescript
// apps/github-app/src/integrations/github/tenant-resolver.ts
export async function resolveTenantFromInstallation(
  installationId: number,
): Promise<TenantConfig> {
  const installation = await db.query.installations.findFirst({
    where: eq(installations.githubInstallationId, installationId),
    with: { tenant: true, aiConfig: true },
  });

  if (!installation || installation.status !== "active") {
    throw new Error(`No active tenant for installation ${installationId}`);
  }

  return {
    tenantId: installation.tenant.id,
    plan: installation.tenant.plan,
    aiProvider: installation.aiConfig?.provider ?? "openai",
    aiModel: installation.aiConfig?.model ?? "gpt-4.1-mini",
    aiApiKey: installation.aiConfig
      ? decryptApiKey(installation.aiConfig.apiKeyEncrypted, installation.aiConfig.apiKeyIv)
      : undefined,
    aiBaseUrl: installation.aiConfig?.baseUrl ?? undefined,
  };
}
```

### Steps

1. Add `packages/db/` with Drizzle ORM + `drizzle-kit`
2. Define schema in TypeScript (tables above)
3. Add PostgreSQL connection management with pool
4. Add API key encryption utilities
5. Create `resolveTenantFromInstallation()` function
6. Add `DATABASE_URL` and `DB_ENCRYPTION_KEY` to `.env.example`
7. Create initial migration
8. Add tenant resolution to the webhook processing chain (initially as optional — fall back to env vars when no tenant is found)

### Risk

- **Medium risk**: Introduces new dependency (PostgreSQL) but does not break existing single-tenant flow
- **Key decision**: Keep backward compatibility — when `DATABASE_URL` is not set, fall back to current env-var behavior

---

## Phase 2 — Auth + Web Frontend

**Goal:** GitHub OAuth login, JWT sessions, and a Next.js dashboard for configuration.

### Auth Flow

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│ Browser  │────→│ /api/auth/   │────→│ GitHub OAuth  │
│          │     │ github       │     │ authorize     │
└──────────┘     └──────────────┘     └───────┬──────┘
                                              │ callback
                                              ▼
                                    ┌──────────────────┐
                                    │ /api/auth/        │
                                    │ github/callback   │
                                    │ → upsert user     │
                                    │ → issue JWT       │
                                    │ → set cookie      │
                                    └──────────────────┘
```

### JWT Design

```typescript
interface JwtPayload {
  sub: string;          // user UUID
  githubId: number;
  githubLogin: string;
  tenantIds: string[];  // tenant UUIDs the user belongs to
  iat: number;
  exp: number;          // 7 days
}
```

- Short-lived access token (15min) in memory
- Refresh token (7d) in httpOnly secure cookie
- Token rotation on refresh

### Web Frontend Pages

```
/                           → Landing page (public)
/login                      → GitHub OAuth redirect
/dashboard                  → Overview (repos, recent reviews, usage)
/dashboard/ai-config        → AI provider configuration
  - Provider selector (OpenAI / Anthropic / Gemini / Compatible)
  - API Key input (masked, encrypted before storage)
  - Model selector
  - Test connection button
/dashboard/repos            → Installed repositories list
/dashboard/usage            → Usage charts (reviews, tokens, cost)
/dashboard/billing          → Subscription management (Phase 4)
/dashboard/settings         → Tenant settings, members, roles
```

### Tech Stack

- **Next.js 15** (App Router, RSC)
- **Tailwind CSS v4**
- **shadcn/ui** components
- **next-auth** or custom OAuth (lightweight)

### API Routes (Next.js)

```
POST /api/auth/github           → initiate OAuth
GET  /api/auth/github/callback  → handle callback, issue JWT
POST /api/auth/refresh          → refresh access token
POST /api/auth/logout           → clear tokens

GET  /api/tenants/:id/ai-config → get AI config (masked keys)
PUT  /api/tenants/:id/ai-config → update AI config
POST /api/tenants/:id/ai-config/test → test AI connection

GET  /api/tenants/:id/usage     → usage stats
GET  /api/tenants/:id/repos     → installed repos
```

### Steps

1. Create `apps/web/` with Next.js + Tailwind + shadcn/ui
2. Implement GitHub OAuth flow
3. Implement JWT auth middleware
4. Build AI config page (CRUD against `ai_configs` table)
5. Build dashboard overview page
6. Build usage page
7. Add API routes for tenant management
8. Add connection test endpoint (calls AI provider with a tiny prompt)

### Risk

- **Medium risk**: New frontend, but isolated from webhook server
- **Key decision**: Web app can share the same domain or be a separate subdomain

---

## Phase 3 — Per-Tenant AI Provider Resolution

**Goal:** Thread tenant context through the entire webhook → AI call chain so each installation uses its configured provider.

### Current Call Chain (to modify)

```
Webhook Event
  → handleGitHubWebhookEvent()
    → handleIssueCommentEvent() / handlePullRequestEvent()
      → handleGitHubIssueCommentCommand() / runGitHubReview()
        → runGitHubAsk() / runGitHubReview()
          → answerPullRequestQuestion() / analyzePullRequest()
            → resolveProvider()  ← reads AI_PROVIDER from env
            → resolveModel()    ← reads *_MODEL from env
            → askWithOpenAI()   ← reads OPENAI_API_KEY from env
```

### Target Call Chain

```
Webhook Event
  → resolveTenantFromInstallation(installationId)  ← NEW
  → handleGitHubWebhookEvent({ ..., tenantConfig })
    → ... (tenantConfig threaded through)
      → answerPullRequestQuestion(input, question, { tenantConfig })
        → resolveProvider(tenantConfig)    ← reads from tenantConfig
        → resolveModel(tenantConfig)       ← reads from tenantConfig
        → askWithOpenAI({ ..., apiKey })   ← uses tenantConfig.apiKey
```

### TenantConfig Interface

```typescript
// packages/core/src/tenant.ts
export interface TenantAIConfig {
  provider: "openai" | "openai-compatible" | "anthropic" | "gemini";
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxConcurrency?: number;
}

export interface TenantConfig {
  tenantId: string;
  plan: "free" | "pro" | "enterprise";
  ai: TenantAIConfig;
}
```

### Migration Strategy

To avoid a big-bang rewrite, introduce tenant context incrementally:

1. **Add optional `tenantConfig` parameter** to `analyzePullRequest()` and `answerPullRequestQuestion()`
2. **If `tenantConfig` is provided**, use its provider/model/key
3. **If not provided**, fall back to existing `process.env` resolution (backward compatible)
4. **Update webhook handlers** to resolve tenant config and pass it through
5. **Remove env-var fallback** only after all paths provide tenant config

### Per-Tenant Concurrency

```typescript
// packages/review/src/tenant-concurrency.ts
const tenantLimiters = new Map<string, AiConcurrencyLimiter>();

export function getTenantLimiter(tenantId: string, maxConcurrency: number): AiConcurrencyLimiter {
  let limiter = tenantLimiters.get(tenantId);
  if (!limiter) {
    limiter = createAiConcurrencyLimiter(maxConcurrency);
    tenantLimiters.set(tenantId, limiter);
  }
  return limiter;
}
```

### Steps

1. Define `TenantConfig` interface in `@mr-agent/core`
2. Add optional `tenantConfig` parameter to `analyzePullRequest()` and `answerPullRequestQuestion()`
3. Create `resolveProviderFromConfig()` and `resolveModelFromConfig()` that read from `TenantConfig` with env-var fallback
4. Update `askWithOpenAI()`, `askWithAnthropic()`, `askWithGemini()` to accept explicit API key parameter
5. Update `callOpenAIJsonWithFallback()` to use explicit client config
6. Create per-tenant concurrency limiter
7. Wire tenant resolution into GitHub App webhook handler (Probot provides `context.payload.installation.id`)
8. Wire into plain webhook handler (installation ID from payload)
9. Wire into GitLab handler (tenant resolution by GitLab project → tenant mapping)
10. Add usage recording after each AI call

### Risk

- **High risk**: Touches every AI call path
- **Mitigation**: Optional parameter with fallback ensures zero regression for self-hosted deployments

---

## Phase 4 — Stripe Billing

**Goal:** Subscription management with free/pro/enterprise tiers.

### Pricing Tiers

| Feature | Free | Pro | Enterprise |
|---|---|---|---|
| Repos | 3 | Unlimited | Unlimited |
| Reviews/month | 50 | Unlimited | Unlimited |
| AI Provider | BYO-Key only | BYO-Key + Platform AI | BYO-Key + Platform AI |
| Commands | Basic (/review, /ask) | All commands | All commands |
| Support | Community | Email | Priority |
| Price | $0 | $29/month | Custom |

### Stripe Integration

```
┌─────────────┐     ┌──────────────┐     ┌─────────┐
│ Web Frontend│────→│ Stripe       │────→│ Stripe  │
│ Pricing Page│     │ Checkout     │     │ Payment │
└─────────────┘     └──────┬───────┘     └────┬────┘
                           │                   │
                    ┌──────▼───────┐     ┌─────▼──────────┐
                    │ success URL  │     │ Stripe Webhook  │
                    │ /billing/ok  │     │ /api/stripe/wh  │
                    └──────────────┘     └─────┬──────────┘
                                               │
                                        ┌──────▼──────────┐
                                        │ Update DB:      │
                                        │ subscription    │
                                        │ status + plan   │
                                        └─────────────────┘
```

### Webhook Events to Handle

```typescript
switch (event.type) {
  case "checkout.session.completed":     // New subscription
  case "customer.subscription.updated":  // Plan change
  case "customer.subscription.deleted":  // Cancellation
  case "invoice.payment_failed":         // Payment failure → grace period
  case "invoice.paid":                   // Successful renewal
}
```

### Subscription Gate in Webhook Flow

```typescript
// apps/github-app/src/middleware/subscription-gate.ts
export function assertSubscriptionActive(tenant: TenantConfig): void {
  if (tenant.plan === "free") {
    // Check usage limits
    const monthlyUsage = await getMonthlyUsage(tenant.tenantId);
    if (monthlyUsage.reviews >= FREE_TIER_REVIEW_LIMIT) {
      throw new SubscriptionLimitError("Free tier review limit reached");
    }
  }
  // Pro/Enterprise: no limits (or check enterprise custom limits)
}
```

### Steps

1. Create Stripe account and configure products/prices
2. Add `stripe` npm package to `apps/web/`
3. Implement checkout session creation API
4. Implement Stripe webhook handler
5. Update subscription table on webhook events
6. Add subscription gate middleware to webhook processing
7. Build billing management page (upgrade, downgrade, cancel, invoices)
8. Add usage metering (count reviews/tokens per tenant per month)

### Risk

- **Medium risk**: Stripe integration is well-documented and standard
- **Key decision**: Grace period strategy for failed payments (suggest 7 days)

---

## Phase 5 — Kubernetes Deployment

**Goal:** Stateless multi-instance deployment with shared PostgreSQL and Redis.

### Target Architecture

```
┌─────────────────────────────────────────────────────┐
│                     Kubernetes Cluster               │
│                                                      │
│  ┌──────────┐  ┌──────────────────────────────────┐ │
│  │ Ingress  │  │        Deployments                │ │
│  │ (nginx)  │──│                                   │ │
│  └──────────┘  │  ┌────────┐ ┌────────┐ ┌───────┐│ │
│                │  │ App    │ │ App    │ │ App   ││ │
│                │  │ Pod 1  │ │ Pod 2  │ │ Pod 3 ││ │
│                │  └───┬────┘ └───┬────┘ └──┬────┘│ │
│                └──────┼──────────┼─────────┼─────┘ │
│                       │          │         │        │
│  ┌────────────────────┼──────────┼─────────┼─────┐ │
│  │   StatefulSets     │          │         │     │ │
│  │                    ▼          ▼         ▼     │ │
│  │  ┌──────────────────────────────────────────┐ │ │
│  │  │              PostgreSQL                  │ │ │
│  │  │  (tenants, users, configs, usage, state) │ │ │
│  │  └──────────────────────────────────────────┘ │ │
│  │                                               │ │
│  │  ┌──────────────────────────────────────────┐ │ │
│  │  │              Redis                       │ │ │
│  │  │  (dedup, rate-limit, sessions, pubsub)   │ │ │
│  │  └──────────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### State Migration

| Current State | Target Backend | Why |
|---|---|---|
| `dedupe-requests` | Redis (SETEX) | Shared across pods, TTL native |
| `rate-limit-records` | Redis (INCR + EXPIRE) | Shared across pods |
| `ask-conversation-turns` | Redis (LIST + EXPIRE) | Shared, ephemeral |
| `review-state` (incremental SHA) | PostgreSQL | Persistent, tenant-scoped |
| `feedback-signals` | PostgreSQL | Persistent, tenant-scoped |

### New RuntimeStateStore: Redis

```typescript
// packages/core/src/runtime-state-redis.ts
export class RedisRuntimeStateStore implements RuntimeStateStore {
  constructor(private redis: Redis) {}

  async load<T>(scope: string, key: string, now: number): Promise<T | undefined> {
    const raw = await this.redis.get(`${scope}:${key}`);
    if (!raw) return undefined;
    const entry = JSON.parse(raw);
    if (entry.expiresAt > 0 && entry.expiresAt <= now) return undefined;
    return entry.value as T;
  }

  async save(params: { scope: string; key: string; value: unknown; expiresAt: number }): Promise<void> {
    const ttlMs = params.expiresAt > 0 ? params.expiresAt - Date.now() : 0;
    const raw = JSON.stringify({ value: params.value, expiresAt: params.expiresAt });
    if (ttlMs > 0) {
      await this.redis.set(`${params.scope}:${params.key}`, raw, "PX", ttlMs);
    } else {
      await this.redis.set(`${params.scope}:${params.key}`, raw);
    }
  }
}
```

### Kubernetes Manifests

```
k8s/
├── base/
│   ├── namespace.yaml
│   ├── deployment.yaml         # github-app (3 replicas)
│   ├── service.yaml
│   ├── ingress.yaml
│   ├── configmap.yaml          # non-secret env vars
│   ├── secret.yaml             # API keys, DB credentials
│   ├── postgresql.yaml         # StatefulSet or use managed PG
│   └── redis.yaml              # StatefulSet or use managed Redis
├── overlays/
│   ├── staging/
│   │   └── kustomization.yaml
│   └── production/
│       └── kustomization.yaml
└── kustomization.yaml
```

### Health Checks for K8s

```yaml
# deployment.yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 15

readinessProbe:
  httpGet:
    path: /health?deep=true
    port: 3000
  initialDelaySeconds: 15
  periodSeconds: 30
```

### Steps

1. Add `ioredis` dependency to `@mr-agent/core`
2. Implement `RedisRuntimeStateStore`
3. Add `RUNTIME_STATE_BACKEND=redis` option with `REDIS_URL` env var
4. Migrate persistent state (review-state, feedback) to PostgreSQL tables
5. Create Kubernetes manifests with Kustomize
6. Create Helm chart (optional, for easier distribution)
7. Add HPA (Horizontal Pod Autoscaler) based on CPU/memory
8. Configure pod disruption budgets for zero-downtime deployments
9. Add GitHub App private key as K8s Secret

### Risk

- **High risk**: Fundamental deployment model change
- **Mitigation**: Redis + PG backends can coexist with existing SQLite/memory backends. Self-hosted users keep using SQLite.

---

## Implementation Timeline Estimate

```
Phase 0: Monorepo          ← structural only, no logic changes
Phase 1: Database           ← foundation for all multi-tenant features
Phase 2: Auth + Web         ← user-facing, can demo early
Phase 3: Per-Tenant AI      ← core value, makes platform usable
Phase 4: Billing            ← monetization
Phase 5: K8s                ← scale
```

## Backward Compatibility

**Critical principle**: Self-hosted single-tenant deployments MUST continue to work with just environment variables. Every multi-tenant feature must be opt-in:

- No `DATABASE_URL` → fall back to env-var AI config
- No `REDIS_URL` → fall back to SQLite/memory state
- No `STRIPE_SECRET_KEY` → no billing enforcement
- No `apps/web/` → webhook server works standalone

This ensures the open-source version remains simple to deploy while the SaaS version adds layers on top.
