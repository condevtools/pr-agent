# PR Agent

AI-powered code review service built with TypeScript + NestJS. This repository is now a `pnpm` monorepo: the backend service lives in `backend/`, and the Next.js frontend lives in `frontend/`.

[中文文档](./README-zh.md)

## Table of Contents

- [Beta Status](#beta-status)
- [Features](#features)
- [Review Triggers](#review-triggers)
- [Roadmap & Process Assets](#roadmap--process-assets)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Platform Integration](#platform-integration)
- [Commands](#commands)
- [Repository Policy](#repository-policy)
- [Observability](#observability)
- [Testing](#testing)
- [License](#license)

---

## Beta Status

- PR Agent is currently in **beta**.
- GitHub App, authenticated plain GitHub Webhook and authenticated GitLab Webhook all use the PostgreSQL execution path.
- Supported commands differ by platform; Fix publication remains GitHub-only and requires qualification and human approval.

## Features

**Core Review**
- Automatic AI code review on PR open / update / merge
- Inline comments with GitHub Suggested Changes
- Report-mode summaries with risk assessment
- Review of immutable base/head revisions frozen when the Run is created
- Mermaid change-structure diagrams in reports (directory/file visualization)
- Secret leak detection in diffs (lightweight regex-based scanning)
- Auto-labeling (bugfix / feature / refactor / docs / security)

**Interactive Commands**
- `/ai-review` — trigger manual review (comment or report mode)
- `/improve [focus]` — force improvement-focused review output
- `/add_doc [focus]` (`/add-doc`) — documentation-only review suggestions
- `/improve_component <component>` — improvement review scoped to a specific component

**Process Guardrails**
- `.pr-agent.yml` per-repo review policy
- Process guideline detection (`.github/.gitlab` workflows, templates, CODEOWNERS, CONTRIBUTING) with compliance suggestions

**Current Support**
- GitHub App
- Plain GitHub Webhook with server credentials and signature verification
- GitLab Webhook with a required secret and server API credentials
- GitHub Actions integration mode — not supported (repository CI is provided separately)

**Multi-Provider AI**
- OpenAI
- OpenAI-compatible (DeepSeek, etc.)
- Anthropic (Claude)
- Google Gemini

### Review Triggers

| Trigger | Review mode |
|---|---|
| GitHub PR opened / edited / synchronized | comment / report, according to repository policy |
| GitHub PR merged | report |
| GitLab MR event | comment / report, according to repository policy |
| Authorized `/ai-review` command | report by default; explicit report / comment accepted |

Duplicate deliveries reuse a durable PostgreSQL source identity and Run. Ordinary Issue events and unsupported commands are ignored; there is no local TTL deduplication window.

Manual review commands require repository write access on GitHub or Developer access on GitLab. The GitHub App needs Metadata read permission to check the commenter. GitLab uses the server's API token to check project membership; its webhook secret is a separate required credential. Ordinary comments and unsupported commands are ignored without calling the model.

### Roadmap & Process Assets

- Competitive gap backlog: `docs/roadmap/2026-02-19-competitive-gap-backlog.md`
- GitHub issue templates: `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`
- GitHub PR template: `.github/pull_request_template.md`
- GitLab issue templates: `.gitlab/issue_templates/Bug.md`, `.gitlab/issue_templates/Feature.md`
- GitLab MR template: `.gitlab/merge_request_templates/default.md`

**Recommended GitHub Flow baseline:**

1. Enable branch protection — require `PR Agent Policy` check and CI to pass.
2. Set `mode: enforce` in `.pr-agent.yml` (start with core repositories, then roll out).
3. Use standardized issue/PR templates to prevent missing requirements and test plans.

---

## Architecture

### Repository Topology

```mermaid
graph LR
    ROOT[pr-agent monorepo]
    ROOT --> BE[backend/<br/>NestJS + Probot + tests]
    ROOT --> FE[frontend/<br/>Next.js marketing / console]
    ROOT --> OPS[Docker / Compose<br/>backend deployment]
    ROOT --> NP[Nixpacks<br/>frontend deployment]
    ROOT --> DOCS[docs/<br/>roadmaps and process assets]
```

### Runtime Architecture

One codebase runs separate web, worker, recovery and maintenance processes. PostgreSQL owns durable Runs, budgets, publication intents, feedback and artifacts. The composition root registers workflows explicitly; only leased workers execute reviews and the model gateway requires a budget context. Recovery reconciles uncertain external effects. An optional verifier runs in an isolated operator deployment.

### Detailed Request Flow

The following diagram shows the production flow. Webhook handlers enqueue reviews; leased workers execute them. GitHub supports review, improve, add_doc and improve_component; GitLab supports review. Single is the default; an explicit API request or an administrator-controlled binding can select Deep. Fix/Evolution require enabled capabilities.

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

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22 (Alpine) |
| Language | TypeScript 5.7 (ES2022, strict mode) |
| Framework | NestJS 11 |
| HTTP Server | Express 4 |
| GitHub App | Probot 13 |
| AI Client | OpenAI SDK 4 (also used for compatible providers) |
| Validation | Zod 3 |
| State Store | PostgreSQL 17 (business state) / process memory (refetchable cache) |
| Container | Docker (multi-stage build) |

---

## Project Structure

See the [backend guide](backend/README.md) for setup, tests and feature documentation.

```
pr-agent/
├── backend/
│   ├── src/
│   │   ├── main.ts                  # NestJS startup entry
│   │   ├── app.module.ts            # Root NestJS composition
│   │   ├── bootstrap/               # Probot, GitHub App and shutdown lifecycle
│   │   ├── http/                    # Routes, authentication and capability APIs
│   │   ├── agent-runtime/           # Run execution, budgets, persistence and publication recovery
│   │   ├── model/                   # Model contracts, providers and concurrency control
│   │   ├── review/                  # Standard/deep review, strategy and rendering
│   │   ├── commands/                # Command recognition, authorization and review intake
│   │   ├── repository/              # Repository ports, diffs and content safety
│   │   ├── issues/                  # Issue similarity, triage and policy
│   │   ├── fix/                     # Fix proposals, verification, approval and publication
│   │   ├── evolution/               # Feedback, datasets, evaluations, candidates and releases
│   │   ├── integrations/            # GitHub / GitLab / notifications adapters
│   │   ├── core/                    # Shared config, HTTP, state, security and utilities
│   │   └── types/                   # Shared ambient type declarations
│   ├── tests/                      # Tests grouped by capability
│   │   ├── support/                # Shared test helpers
│   │   └── fixtures/               # Test inputs and child-process fixtures
│   ├── docs/                       # Runtime, API, operations and feature manuals
│   ├── validation/                 # Historical engineering, capacity and model evidence
│   ├── README.md                   # Backend setup and verification guide
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── app/                        # Next.js App Router pages and layouts
│   ├── components/                 # Frontend UI components
│   ├── public/                     # Static assets
│   ├── package.json
│   └── next.config.ts
├── docs/                           # Local planning material (not versioned)
├── secrets/                        # Local private key mount (not committed)
├── Dockerfile                      # Backend container image
├── docker-compose.yml              # Backend deployment and local ops
├── nixpacks.toml                   # Root Nixpacks entry for frontend
├── package.json                    # Workspace scripts
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── turbo.json
├── README-zh.md
└── README.md
```

### Workspace Notes

- The repository root `.env` is shared by local backend development and Docker Compose.
- `backend/` is the deployable review service. `frontend/` is deployed separately when using root `nixpacks.toml`.
- PostgreSQL is the authoritative persistent store; Compose keeps it in the named `harness-postgres` volume.

### Backend Path Aliases

The backend package uses Node.js ESM subpath imports (configured in `backend/tsconfig.json` and `backend/package.json`):

| Alias | Maps to |
|---|---|
| `#core` | `backend/src/core/index.ts` |
| `#review` | `backend/src/review/index.ts` |
| `#model` | `backend/src/model/index.ts` |
| `#integrations/github` | `backend/src/integrations/github/index.ts` |
| `#integrations/gitlab` | `backend/src/integrations/gitlab/index.ts` |
| `#integrations/notifications` | `backend/src/integrations/notifications/index.ts` |

---

## Getting Started

### Prerequisites

- Node.js >= 22
- pnpm >= 10

### Local Development

```bash
# Install workspace dependencies
pnpm install

# Prepare env file at repository root
cp .env.example .env

# Start backend locally (reads ../.env from backend package)
pnpm dev:backend

# Start frontend locally
pnpm dev:frontend

# Build backend for production
pnpm --filter backend build

# Start built backend
pnpm --filter backend start
```

The backend listens on port `3000` by default (configurable via `PORT`). The frontend also defaults to `3000` when run separately.

### Health Check

```bash
curl http://localhost:3000/health
curl 'http://localhost:3000/github/health?deep=1' # Local webhook configuration only; never calls a model
curl http://localhost:3000/ready              # Checks enabled runtime dependencies
curl http://localhost:3000/github/health       # GitHub config status
```

---

## Configuration

### Environment Variables

Copy `.env.example` and fill in the required values. Choose the minimal configuration for your platform:

- `.env.github-app.min.example` — GitHub App minimum

- `.env.github-webhook.min.example` — plain GitHub Webhook minimum
- `.env.gitlab.min.example` — GitLab Webhook minimum

### AI Provider

`HARNESS_MODEL_PRICING_JSON` is required by the web and worker roles. Copy the complete policy from [`.env.example`](.env.example), select the entry matching `AI_PROVIDER` and the configured model, then replace every illustrative rate and tenant/run cap with the values for your provider contract and deployment budget. The example is deliberately non-zero but is not a statement of current vendor pricing; do not deploy it unchanged. OpenAI-compatible entries must also declare `openAiTokenParameter`.

```mermaid
graph LR
    ENV[AI_PROVIDER env var]
    ENV -->|openai| OAI[OpenAI<br/>OPENAI_API_KEY + OPENAI_MODEL]
    ENV -->|openai-compatible| OC[OpenAI-Compatible<br/>OPENAI_BASE_URL + OPENAI_COMPATIBLE_MODEL]
    ENV -->|anthropic| ANT[Anthropic<br/>ANTHROPIC_API_KEY + ANTHROPIC_MODEL]
    ENV -->|gemini| GEM[Gemini<br/>GEMINI_API_KEY + GEMINI_MODEL]
```

**OpenAI (default)**
```env
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
```

**OpenAI-Compatible (e.g., DeepSeek)**
```env
AI_PROVIDER=openai-compatible
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_COMPATIBLE_API_KEY=...
OPENAI_COMPATIBLE_MODEL=deepseek-chat
```

**Anthropic**
```env
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-3-5-haiku-latest
ANTHROPIC_MAX_TOKENS=8192
```

**Gemini**
```env
AI_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.0-flash
```

### State Persistence

PostgreSQL is the authority for runs, rate limits, review cursors, feedback and verified webhook replay. Process memory is used only for refetchable caches.

### Notifications (Optional)

Supports WeChat (WeCom), Slack, Discord, and generic JSON webhooks:

```env
NOTIFY_WEBHOOK_URL=https://hooks.slack.com/services/...
NOTIFY_WEBHOOK_FORMAT=slack   # wecom | slack | discord | generic
```

### Key Tuning Parameters

**AI provider tuning**

| Variable | Default | Description |
|---|---|---|
| `AI_HTTP_TIMEOUT_MS` | `30000` (30s) | HTTP timeout for AI review requests |
| `AI_HTTP_RETRIES` | `2` | Number of retries on transient AI provider failures |
| `AI_HTTP_RETRY_BACKOFF_MS` | `400` | Retry backoff base delay for AI provider requests (ms) |
| `AI_MAX_CONCURRENCY` | `4` | Max concurrent AI requests |
| `AI_MAX_QUEUE_SIZE` | `200` | Max queued AI requests before rejecting new work |
| `AI_SHUTDOWN_DRAIN_TIMEOUT_MS` | `15000` (15s) | Graceful shutdown drain timeout for in-flight AI tasks |
| `AI_DEBUG_LOGS` | `false` | Log AI request/response payloads for debugging |
| `FEATURE_DEEP_REVIEW` | `on` | Allow explicit Deep Review; PR webhooks still default to Single |
| `FEATURE_FIX` | `off` | Enable Fix only with binding permission, policy and verifier dependencies |
| `FEATURE_EVOLUTION` | `off` | Enable feedback and offline evaluation for authorized bindings |

`AI_CONCURRENCY_LIMIT` is no longer used. Use `AI_MAX_CONCURRENCY` and `AI_MAX_QUEUE_SIZE` instead.

**Global runtime and command limits**

| Variable | Default | Description |
|---|---|---|
| `WEBHOOK_BODY_LIMIT` | `1mb` | Global Express body-parser limit for webhook requests (returns `413` when exceeded) |
| `COMMAND_RATE_LIMIT_MAX` | `10` | Max command invocations per user per PR/MR per window |
| `COMMAND_RATE_LIMIT_WINDOW_MS` | `3600000` (1h) | Command rate-limit window |

**GitHub-specific**

| Variable | Default | Description |
|---|---|---|
| `GITHUB_INCREMENTAL_STATE_TTL_MS` | `604800000` (7d) | Incremental review SHA cache lifetime |
| `GITHUB_POLICY_CONFIG_CACHE_TTL_MS` | `300000` (5min) | `.pr-agent.yml` cache for policy/review behavior |
| `GITHUB_WEBHOOK_MAX_BODY_BYTES` | `10485760` (10MB) | Extra hard cap for `/github/trigger` payload size |
| `GITHUB_WEBHOOK_SKIP_SIGNATURE` | `false` | Debug-only signature bypass; forbidden when `NODE_ENV=production` |

**GitLab-specific**

| Variable | Default | Description |
|---|---|---|
| `GITLAB_INCREMENTAL_STATE_TTL_MS` | `604800000` (7d) | Incremental review SHA cache |
| `GITLAB_POLICY_CONFIG_CACHE_TTL_MS` | `300000` (5min) | `.pr-agent.yml` policy cache |
| `GITLAB_WEBHOOK_MAX_BODY_BYTES` | `10485760` (10MB) | Extra hard cap for `/gitlab/trigger` payload size |
| `GITLAB_WEBHOOK_SECRET` | Required for GitLab | Missing or incorrect webhook secrets are rejected; request headers cannot provide API credentials or override review policy |
| `ALLOW_INSECURE_GITLAB_HTTP` | `false` | Allow `http://` GitLab base URL for local testing only |

**Tuning guidance:**

- `COMMAND_RATE_LIMIT_*` — Controls abuse protection for comment commands. Increase limits for very active repos; lower limits if bots/users spam command threads.

See `.env.example` for the baseline variable reference; advanced runtime knobs are listed above.

---

## Deployment

### Docker (Recommended)

```mermaid
graph LR
    subgraph Docker Build
        B1[Build stage<br/>compile backend]
        B2[Dependency stage<br/>production packages only]
        B3[Runtime stage<br/>non-root node:22-alpine]
        B1 -->|dist| B3
        B2 -->|node_modules| B3
    end
    B3 --> W[web container]
    B3 --> Q[worker container]
    B3 --> R[recovery container]
    B3 --> M[maintenance container]
```

**Build & Run**

```bash
docker build -t pr-agent:latest .
docker run -d \
  --name pr-agent \
  --user 10001:10001 --read-only --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m \
  -p 3000:3000 \
  --env-file .env \
  pr-agent:latest
```

The application image does not embed PostgreSQL or initialize external database roles. A standalone container therefore requires a separately provisioned PostgreSQL database, restricted schema-owner/application roles, and a completed migration run. The one-container `all` role is for local evaluation. Production deployments run separate `web`, `worker`, `recovery`, and `maintenance` instances; use Compose below when the platform does not already manage those processes.

To publish an application image to GHCR, run these commands from the repository root with Docker running and Buildx installed:

```bash
pnpm docker:login
pnpm docker:image:push
pnpm docker:image:inspect
pnpm docker:image:ref
```

The login command uses `Lemonadeccc`; enter a [GitHub personal access token (classic)](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-with-a-personal-access-token-classic) with `write:packages` and permission to publish the package. For a different account, run `docker login ghcr.io -u YOUR_USERNAME` directly. The default image is `ghcr.io/lemonadeccc/pr-agent:sha-<12-character Git commit>`. The push command builds and publishes both `linux/amd64` and `linux/arm64`; a separate build command is optional. It creates or reuses the named `pr-agent-builder` without changing your selected builder. Commit changes to Dockerfile inputs before pushing: the script rejects modified or untracked image source files. Local `.env`, `.codex`, and `.omx` files do not block this check.

For a local build without uploading, use `pnpm docker:image:build`. This writes a multi-architecture OCI archive under `dist/docker/`; it does not load the image into `docker images`. Preview a build or push with `--dry-run`. To override the repository, tag, or builder, export `PR_AGENT_IMAGE`, `PR_AGENT_TAG`, or `PR_AGENT_BUILDER` before running the commands. The script does not read `.env`; application credentials stay in the deployment environment and are excluded from the build context.

`docker:image:inspect` checks the published manifest. BuildKit provenance entries reported as `unknown/unknown` are attestations associated with the two images, not an additional runtime architecture. A Git push alone does not publish an image: the current CI validates builds without pushing to GHCR.

For a Coolify deployment that pulls images, use the same reference printed by `docker:image:ref` for `pr-agent`, `worker`, `recovery`, `maintenance`, and `database-init`; PostgreSQL keeps its own image. Update Coolify's saved Compose configuration separately. Publishing an image does not update that configuration or upgrade an existing database volume; follow the Compose and database upgrade instructions below.

When Fix verification is enabled, publish its two separate targets on the same commit:

```bash
pnpm docker:image:push --target verifier
pnpm docker:image:push --target verifier-sandbox
```

Without `PR_AGENT_IMAGE`, these use `ghcr.io/lemonadeccc/pr-agent-verifier` and `ghcr.io/lemonadeccc/pr-agent-verifier-sandbox`. An explicit `PR_AGENT_IMAGE` is used exactly as supplied for every target, so choose a different value for each target when overriding it. Normal review deployments do not need these images. The application image contains no Docker CLI.

### Docker Compose

Copy `.env.example` to `.env` and replace all placeholders. Compose requires five distinct, randomly generated PostgreSQL passwords and has no password fallbacks:

```env
HARNESS_BOOTSTRAP_PASSWORD=...
HARNESS_MIGRATION_PASSWORD=...
HARNESS_APP_PASSWORD=...
HARNESS_VERIFIER_PASSWORD=...
HARNESS_MAINTENANCE_PASSWORD=...
HARNESS_ONBOARDING_PASSWORD=...
```

```bash
# Start
docker compose up -d --build

# View logs
docker compose logs -f pr-agent worker recovery maintenance

# Restart
docker compose restart pr-agent worker recovery maintenance

# Stop
docker compose down
```

The `docker-compose.yml` uses:

- `harness-postgres` — PostgreSQL business state and migration ledger
- `pr-agent` — the public `web` process only
- `worker` and `recovery` — independent durable execution processes
- `maintenance` — restricted periodic retention in safe `preview` mode by default
- `PRIVATE_KEY` — the default inline GitHub App PEM path, suitable for Coolify and other secret environment managers
- `docker-compose.secret-file.yml` — an optional PEM file overlay for hosts with a managed secret file

On a fresh volume, PostgreSQL bootstraps restricted migrator, application, verifier, maintenance, and GitHub onboarding roles. After `database-init` applies the schema, the one-shot `onboarding-role-init` service creates or rotates the least-privilege onboarding role for both fresh and existing volumes. Changing other `.env` passwords does not rotate existing roles. Volumes created by the former superuser `pr_agent_migrator` layout require the explicit, backed-up upgrade procedure in [backend/docs/operations.md](backend/docs/operations.md#旧-volume-角色升级); do not delete the volume or run the new migrator first.

Compose uses `.env` only for interpolation. Each service receives an explicit allowlist rather than the whole file. Web, worker, and recovery receive only the application database password; model provider keys are injected only into worker, API principal configuration only into web, and maintenance receives only its dedicated database password and retention settings.

Maintenance scans bounded batches and defaults to `HARNESS_MAINTENANCE_MODE=preview`, which performs no deletion. Set `apply` explicitly only after reviewing the configured windows. The validated defaults are 30 days before content is scrubbed (including replay payloads), 90 days before scrubbed replay rows are removed, and 400 days before trace/audit rows and a strictly eligible ordinary Run's complete FK graph may be removed, with `7 <= content < replay < trace <= 3650`. A fully removed ordinary Run no longer reserves its old idempotency key. Qualified data, active holds, shared/current publication identities, and other strong references block that full-graph deletion.

All application roles use fixed UID/GID `10001:10001`, a read-only root filesystem, bounded tmpfs, no Linux capabilities, and `no-new-privileges`. Base Compose accepts the PEM only through `PRIVATE_KEY` and leaves `PRIVATE_KEY_PATH` empty, so Coolify does not need a host file. To use a file, start with `docker compose -f docker-compose.yml -f docker-compose.secret-file.yml up -d`; the overlay clears the inline key and mounts only the PEM path. Local Compose warns that file-secret `uid`, `gid`, and `mode` remapping is unsupported, so Linux hosts must provision the source file for UID/GID `10001:10001` with mode `0400` (or use the deployment platform's secret-file mechanism). None of these containers mounts a Docker socket or a verifier snapshot directory.

Fix verification is absent from the normal Compose deployment. When Fix is enabled, deploy `docker-compose.verifier-operator.yml` only on a dedicated host or VM with its own local Docker daemon. The operator receives only its restricted PostgreSQL URL, frozen policy registry, and local daemon socket; it exposes no HTTP port and receives no GitHub, GitLab, model, or webhook credentials. The embedded Compose PostgreSQL has no host port, so a remote operator requires a separately managed PostgreSQL endpoint or a protected private network path; never publish PostgreSQL directly to the Internet. A read-only Docker socket still grants Docker API control, so it is never mounted into the application deployment.

### Nixpacks (Frontend Only)

The root `nixpacks.toml` is for deploying `frontend/` from the repository root. It does not build or start the backend service.

- Install: `pnpm install --frozen-lockfile`
- Build: `pnpm --filter frontend build`
- Start: `pnpm --filter frontend start`

### Production Deployment Checklist

```mermaid
graph TD
    A[Choose Platform Mode] -->|GitHub App| B1[Create GitHub App]
    A -->|Plain Webhook| B2[Generate PAT Token]
    A -->|GitLab| B3[Generate API Token]

    B1 --> C[Configure AI Provider]
    B2 --> C
    B3 --> C

    C --> D[Initialize PostgreSQL schema]
    D --> E[Deploy Container]
    E --> F[Configure Webhook URL]
    F --> G[Verify Health Endpoints]
    G --> H[Test with /ai-review Command]
```

1. **Configure platform credentials and webhook verification** — GitHub App, plain GitHub or GitLab
2. **Configure AI provider and budget policy** — Set `AI_PROVIDER`, the corresponding API key/model, and a deployment-specific `HARNESS_MODEL_PRICING_JSON` derived from [`.env.example`](.env.example)
3. **Initialize PostgreSQL** — For GitHub App Compose, configure all six distinct database passwords and require `database-init` plus `onboarding-role-init` to complete successfully; external PostgreSQL deployments must provision equivalent restricted roles
4. **Deploy the container** — Docker, Docker Compose, Render, Railway, Fly.io, or K8s
5. **Set webhook URL** — append `/api/github/webhooks` for GitHub App, `/github/trigger` for plain GitHub, or `/gitlab/trigger` for GitLab to your HTTPS domain
6. **Verify** via health endpoints and a test `/ai-review` comment

### Quick Deployment Reference

This is a compact deployment path for Render/Railway/Fly.io/Docker/K8s.

1. **Use GitHub App mode**
2. **Use minimal environment variables**

**GitHub App minimum (`.env.github-app.min.example`)**

```env
APP_ID=123456
PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----\\n"
# PRIVATE_KEY_PATH=/run/secrets/github-app-private-key.pem
WEBHOOK_SECRET=replace-with-webhook-secret
AI_PROVIDER=openai
OPENAI_API_KEY=replace-with-openai-key
OPENAI_MODEL=gpt-4.1-mini
# Copy HARNESS_MODEL_PRICING_JSON from .env.example, then replace its illustrative rates and caps.
```

`HARNESS_MODEL_PRICING_JSON` is mandatory for the web and worker roles. Its model key must match the selected `provider:model`; use the complete [`.env.example`](.env.example) policy as a schema example, not as production pricing.

**Required durable runtime configuration**

```env
HARNESS_DATABASE_URL=postgresql://pr_agent_app:password@postgres:5432/pr_agent
```

Webhook replay is stored in PostgreSQL after signature verification. Grant `replay:read` or `replay:execute` to a scoped API principal.

3. **Start backend application**

```bash
pnpm install --frozen-lockfile
pnpm --filter backend build
pnpm --filter backend start
```

The backend listens on `PORT` (default `3000`).

4. **Configure webhook address**
   - GitHub App: `https://<domain>/api/github/webhooks`
5. **Docker one-liner**

```bash
docker build -t pr-agent:latest .
docker run -d --name pr-agent --user 10001:10001 --read-only --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m \
  -p 3000:3000 --env-file .env pr-agent:latest
```

6. **Verification checklist**
   - `GET /health`
   - `GET /github/health`
   - `GET /metrics`
   - Test PR/MR commands: `/ai-review`, `/ai-review comment`
   - Webhook failure response includes structured fields: `error/type/status/path/method/timestamp`

For a principal with the matching scoped permission:
- `GET /webhook/events`
- `POST /github/replay/:eventId`
- Header: `Authorization: Bearer <HARNESS_API_PRINCIPAL_TOKEN>`

### Nginx Reverse Proxy

There is no committed `deploy/nginx/` sample in this repository; use the snippet below as a baseline:

```nginx
server {
    listen 443 ssl;
    server_name pr-agent.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Platform Integration

### GitHub App

1. Create a GitHub App with the following permissions:
   - **Pull requests**: Read & write
   - **Issues**: Read & write
   - **Contents**: Read-only
   - **Checks**: Read-only
   - **Metadata**: Read-only
2. Subscribe to events:
   - `Pull request` (`opened` / `edited` / `synchronize` / `closed`)
   - `Issue comment`
   - `Pull request review thread` (`resolved` / `unresolved`, for feedback learning)
3. Set webhook URL to `https://<domain>/api/github/webhooks`
4. Configure environment variables:

```env
APP_ID=123456
PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
# PRIVATE_KEY_PATH=/run/secrets/github-app-private-key.pem
WEBHOOK_SECRET=your-webhook-secret
HARNESS_ONBOARDING_PASSWORD=replace-with-a-distinct-onboarding-password
# FEATURE_GITHUB_ONBOARDING=auto  # default; install-and-use
```

- GitHub App enablement condition (see `backend/src/bootstrap/github-app/github-app-bootstrap.service.ts`): `APP_ID` + (`PRIVATE_KEY` or `PRIVATE_KEY_PATH`) + `WEBHOOK_SECRET`.
- With complete credentials, `auto` is the default: install the App and select repositories in GitHub; startup and periodic discovery also synchronize existing installations. There is no onboarding admin page or per-repository token step. `off` stops positive automation only and still requires the restrictive onboarding role.
- See [GitHub App install-and-use operations](backend/docs/github-onboarding.md) for existing-install adoption, conflicts, observability, and the exact `701c6b97abe005b95c64e192e403d142e96f8696` rollback contract. The documentation describes a supported procedure; it does not claim a deployment occurred.
- That exact old-image rollback requires `FEATURE_GITHUB_ONBOARDING=on`; the old parser rejects `auto`, and leaving the variable unset would disable restrictive lifecycle processing. Never down-migrate the database.
- Base `docker-compose.yml` uses inline `PRIVATE_KEY` and does not require a host PEM, which is the Coolify-compatible path. The optional `docker-compose.secret-file.yml` overlay creates the file secret from `./secrets/github-app.private-key.pem`; on Linux, provision it for UID/GID `10001:10001` with mode `0400` before starting the overlay.
- For the optional file overlay, create only the managed secret directory: `mkdir -p secrets`.

> GitHub App mode requires its complete credential set. Deployments using plain GitHub or GitLab webhooks configure the corresponding server credentials and webhook secret instead.

### Other Webhook Integrations

Plain GitHub uses `/github/trigger`; GitLab uses `/gitlab/trigger`. Configure server API credentials, the platform webhook secret, and an active repository binding before sending events. Request headers cannot supply API credentials or override repository policy.

---

## Commands

All commands are triggered via PR/MR comments. Commands marked with **(PR only)** require Pull Request context (diff, CI checks) and will not work in Issue comments.

| Command | Description |
|---|---|
| `/ai-review` **(PR only)** | Trigger AI review (defaults to `report` when no mode is provided) |
| `/ai-review report` **(PR only)** | Force report mode (summary comment) |
| `/ai-review comment` **(PR only)** | Force comment mode (inline comments) |
| `/ai-review --mode=report` / `--mode=comment` **(PR only)** | Flag-style mode override (same effect as positional mode) |
| `/improve [focus]` **(PR only)** | Run review in improvement-only mode |
| `/add_doc [focus]` / `/add-doc [focus]` **(PR only)** | Generate documentation-only suggestions |
| `/improve_component <component>` **(PR only)** | Improvement review scoped to a specific component |

GitHub supports all four commands above. GitLab currently supports `/ai-review` only. Other comment content is acknowledged and ignored without invoking the model.

---

## Repository Policy

Add `.pr-agent.yml` to the repository root to configure per-repo behavior:

```yaml
review:
  enabled: true
  mode: comment         # comment | report
  onOpened: true        # Review on PR open
  onEdited: false
  onSynchronize: true   # Review on new commits
  includeCiChecks: true
  improveCommandEnabled: true
  addDocCommandEnabled: true
  secretScanEnabled: true
  autoLabelEnabled: true
  secretScanCustomPatterns:  # optional extra secret regex patterns
    - "(?i)my_internal_token_[a-z0-9]{16,}"
  customRules:
    - All public APIs must have type annotations
    - No new `any` types allowed
```

GitHub and GitLab read the `review:` section from `.pr-agent.yml`. Issue/PR template enforcement is not part of the PostgreSQL-backed command path.

**Review field reference:**

| Field | Description |
|---|---|
| `enabled` / `mode` | Enable AI review and set default mode (comment / report) |
| `onOpened` / `onEdited` / `onSynchronize` | Control which PR events auto-trigger review |
| `includeCiChecks` | Include CI check results in AI context |
| `improveCommandEnabled` | Enable `/improve` command |
| `addDocCommandEnabled` | Enable `/add_doc` (`/add-doc`) command |
| `secretScanEnabled` | Scan diffs for potential secret leaks and post security warnings |
| `secretScanCustomPatterns` | Additional repository-specific secret regex patterns |
| `autoLabelEnabled` | Auto-add PR labels based on change content |
| `customRules` | Team-specific review rules (natural language); included in reviews |

---

## Observability

### Metrics

Prometheus-format metrics are exposed at `GET /metrics`:

- `pr_agent_webhook_requests_total` — webhook request count by platform & event
- `pr_agent_webhook_results_total` — results by platform & outcome (ok/error)
- `pr_agent_webhook_replay_total` — replay execution outcomes
- `pr_agent_webhook_store_writes_total` — persisted debug-event write count
- `pr_agent_webhook_store_trim_total` — debug-event store trim operations
- `pr_agent_health_checks_total` — health endpoint call count
- `pr_agent_http_errors_total` — global HTTP error count
- `pr_agent_process_uptime_seconds` — process uptime
- `pr_agent_ai_requests_active` — active AI request count
- `pr_agent_ai_wait_queue_size` — queued AI request count
- `pr_agent_ai_shutdown_requested` — AI shutdown flag (0/1)
- `pr_agent_runtime_state_backend_info{backend=...}` — selected runtime-state backend info gauge

### Health Checks

| Endpoint | Purpose |
|---|---|
| `GET /health` | Public liveness probe; platform `/github/health` and `/gitlab/health` routes accept `?deep=1` to check local webhook configuration |
| `GET /ready` | Readiness for enabled capabilities and runtime dependencies |
| `GET /github/health` | GitHub webhook config validation |
| `GET /gitlab/health` | GitLab webhook config validation |

### Error Handling

Webhook errors return structured JSON. Known webhook errors (e.g. `BadWebhookRequestError`, `WebhookAuthError`) include a descriptive message; unrecognized internal errors are sanitized to `"internal server error"` to prevent information leakage.

```json
{
  "ok": false,
  "error": "webhook secret verification failed",
  "type": "WebhookAuthError",
  "status": 401,
  "path": "/github/trigger",
  "method": "POST",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

Payloads exceeding `WEBHOOK_BODY_LIMIT` (default `1mb`) return `413 Payload Too Large`.

### Webhook Replay

Verified success and failure envelopes are stored in PostgreSQL. Endpoints require a tenant- and integration-scoped API principal:
- `GET /webhook/events` — list stored events
- `POST /github/replay/:eventId` — replay a GitHub event
- `POST /gitlab/replay/:eventId` — replay a GitLab event

### Resilience

- **HTTP Retry**: exponential backoff (2 retries, 400ms base delay) on 408/429/5xx
- **Idempotency**: PostgreSQL source keys, immutable request hashes, and publication operation identities
- **Rate Limiting**: PostgreSQL-backed per-user/per-command windows prevent process restarts from resetting limits
- **Graceful Shutdown**: drains in-flight requests on SIGTERM/SIGINT

---

## Testing

```bash
# Backend tests
pnpm test:backend

# Backend coverage
pnpm --filter backend test:coverage

# Backend type check
pnpm --filter backend check

# Docker-only PostgreSQL suite (includes fresh and upgrade migration paths)
pnpm --filter backend test:harness:pg

# Frontend lint and production build
pnpm --filter frontend lint
pnpm --filter frontend build

# Real Docker verifier fixture (requires a locally built immutable sandbox image ID)
docker build --target verifier-sandbox -t pr-agent-verifier-sandbox:test .
FIX_VERIFIER_SANDBOX_IMAGE_DIGEST="$(docker image inspect pr-agent-verifier-sandbox:test --format '{{.Id}}')" \
  pnpm --filter backend test fix/fix-docker-verifier.test.ts
```

Backend tests use the Node.js built-in test runner (`node:test`). `.github/workflows/ci.yml` runs backend check/build/unit/build verification, the isolated Docker PostgreSQL suite, a fresh split-runtime Compose smoke with private provider fixtures, frontend lint/build, the real hostile verifier fixture, and non-publishing `amd64/arm64` builds for the application, verifier, and sandbox targets. CI uses no external provider credentials and never deploys or pushes an image.

Recommended regression coverage includes:
- AI concurrency control
- Cache & dedup behavior
- Diff parsing & hunk prioritization
- GitHub/GitLab integration logic
- HTTP retry & error handling
- Policy validation
- Notification adapters
- NestJS module wiring

---

## License

Private — see repository for details.
