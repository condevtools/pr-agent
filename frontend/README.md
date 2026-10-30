# PR Agent — Landing Page

The marketing and documentation site for **PR Agent**, an AI-powered code review service built on GitHub App + GitLab Webhook workflows.

**Tech stack**: Next.js (App Router) · Tailwind CSS · GSAP · TypeScript

## Getting Started

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to preview.

## Project Structure

```
frontend/
├── app/
│   ├── components/     # UI sections (Hero, Features, Pricing …)
│   ├── i18n/           # en / zh locale provider
│   └── page.tsx        # Home page composition
├── lib/                # SEO, JSON-LD, shared utilities
└── public/             # Static assets (logo, images)
```

## Architecture

The following diagram shows the production backend flow. Webhook handlers enqueue reviews; leased workers execute them. See the root README for supported commands and capability settings.

```mermaid
flowchart LR
    GH[GitHub App / webhook] --> SIGN[Signature + payload validation]
    GL[GitLab webhook] --> SIGN
    SIGN --> ROUTE[Canonical event + command recognition]
    ROUTE --> IGNORE[Ignore ordinary / unsupported / unmanaged events]
    ROUTE --> AUTH[Repository binding; command author permission]
    AUTH --> ENQUEUE[Explicit review enqueue]
    API[Protected Run API] --> ENQUEUE
    ENQUEUE --> PG[(PostgreSQL: Runs, budget, events, artifacts)]
    PG --> WORKER[Compatible leased Worker]
    WORKER --> REVIEW[Single / explicit Deep Review]
    REVIEW --> MODEL[Budgeted model gateway]
    REVIEW --> PUB[Durable publication batch]
    PUB --> PROVIDER[GitHub / GitLab]
    RECOVERY[Recovery: reconcile uncertain effects] --> PUB
    FEEDBACK[Authorized feedback command / API] --> PG
    FIX[Optional Fix + isolated verifier + human approval] --> PG
    EVOLUTION[Optional Evolution evaluation / release] --> PG
    MAINT[Restricted maintenance: preview / retention] --> PG
    HEALTH[Liveness / capability-aware readiness] -.-> PG
```

## Deployment

Build and run in production:

```bash
pnpm --filter frontend build
pnpm --filter frontend exec next start -H 0.0.0.0 -p ${PORT:-3000}
```

### Coolify + Nixpacks (deploy `frontend` from repository root)

The repository root now includes `nixpacks.toml` with:

- Install: `pnpm install --frozen-lockfile`
- Build: `pnpm --filter frontend build`
- Start: `pnpm --filter frontend exec next start -H 0.0.0.0 -p ${PORT:-3000}`

Recommended Coolify settings:

- Build Pack: `Nixpacks`
- Base Directory: `/` (repository root)
- Port: `3000`
- Environment variable: `NODE_ENV=production`

## License

MIT
