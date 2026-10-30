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
- The only officially supported integration mode is **GitHub App**.
- Plain GitHub Webhook and GitLab code paths may still exist in the repository, but they are not part of the supported deployment surface right now.

## Features

**Core Review**
- Automatic AI code review on PR open / update / merge
- Inline comments with GitHub Suggested Changes
- Report-mode summaries with risk assessment
- Incremental review (only new commits since last review)
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
- GitHub App only
- Plain GitHub Webhook — unsupported in the current beta
- GitLab Webhook — unsupported in the current beta
- GitHub Actions — not supported

**Multi-Provider AI**
- OpenAI
- OpenAI-compatible (DeepSeek, etc.)
- Anthropic (Claude)
- Google Gemini

### Review Triggers

| Trigger | Mode | Dedup Window |
|---|---|---|
| PR opened (`opened`) | comment / report (per config) | 5 min |
| PR updated (`synchronize`) | comment / report | 5 min (per new commit SHA) |
| PR edited (`edited`) | comment / report | 5 min |
| PR merged (`closed` + merged) | report | 24h (configurable) |
| `/ai-review` comment command | comment / report | 5 min |
| `/ai-review report` | report | 5 min |
| `/ai-review comment` | comment | 5 min |
| Issue created / edited | pre-check (GitHub) + default auto-triage when policy file is missing | 5 min |
| PR created / edited / synced | pre-merge check (GitHub) | — |

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

### High-Level Overview

```mermaid
graph TB
    subgraph Platforms
        GH_APP[GitHub App<br/>Probot]
        GH_WH[GitHub Webhook]
        GL_WH[GitLab Webhook]
    end

    subgraph NestJS Application
        direction TB
        CTRL[Controllers<br/>Route & Validate]
        SVC[Services<br/>Signature Verify & Dispatch]
        INT[Integration Layer<br/>GitHub / GitLab Adapters]
        RE[Review Engine<br/>AI Reviewer + Patch Parser]
        RR[Report Renderer<br/>Markdown + Suggestions]
    end

    subgraph External
        AI[AI Providers<br/>OpenAI / Anthropic / Gemini]
        GH_API[GitHub API]
        GL_API[GitLab API]
        NOTIFY[Notifications<br/>Slack / Discord / WeChat]
    end

    GH_APP -->|Webhook Event| CTRL
    GH_WH -->|Webhook Event| CTRL
    GL_WH -->|Webhook Event| CTRL
    CTRL --> SVC
    SVC --> INT
    INT --> RE
    RE -->|LLM Call| AI
    RE --> RR
    RR -->|Post Comment / Report| GH_API
    RR -->|Post Comment / Report| GL_API
    INT -.->|Optional| NOTIFY
```

### Request Processing Flow

```mermaid
sequenceDiagram
    participant P as Platform (GitHub/GitLab)
    participant C as Controller
    participant S as Service
    participant D as Deduplication
    participant I as Integration
    participant A as AI Reviewer
    participant R as Report Renderer

    P->>C: Webhook Event
    C->>S: Validate signature & parse payload
    S->>D: Check dedup (FNV hash, 5min window)
    alt Duplicate
        D-->>S: Skip (already processed)
    else New request
        D-->>S: Proceed
        S->>I: Dispatch to platform handler
        I->>I: Fetch diff, file contents, policy
        I->>A: Send context + diff to AI model
        A-->>I: Structured review result (Zod-validated)
        I->>R: Format report / inline comments
        R->>P: Post review via API
        I-->>P: Optional notification webhook
    end
```

### Module Dependency Graph

```mermaid
graph LR
    APP[AppModule] --> HTTP[http: capability APIs]
    APP --> BOOT[bootstrap: Probot and lifecycle]
    HTTP --> RUN[agent-runtime]
    HTTP --> FIX[fix]
    HTTP --> EVO[evolution]
    BOOT --> REV[review: standard and deep]
    BOOT --> CMD[commands]
    RUN --> REV
    RUN --> FIX
    RUN --> EVO
    RUN --> PG[PostgreSQL]
    REV --> MODEL[model]
    REV --> REPO[repository]
    REV --> INT[integrations]
    CMD --> REV
    CMD --> MODEL
    CMD --> INT
    FIX --> MODEL
    FIX --> REPO
    EVO --> MODEL
    EVO --> REV
    MODEL --> CORE[core]
    REPO --> CORE
    INT --> CORE
```

### Detailed Request Flow

The following diagram traces every request path — from webhook entry through event routing, command parsing, the common review engine, and output delivery.

```mermaid
flowchart LR
    subgraph E["Entry Endpoints (NestJS + Probot)"]
        E1["/api/github/webhooks<br/>GithubAppBootstrapService"]
        E2["/github/trigger<br/>GithubWebhookController"]
        E3["/gitlab/trigger<br/>GitlabWebhookController"]
        E4["/github/replay/:eventId<br/>/gitlab/replay/:eventId"]
        E5["/health /metrics /webhook/events"]
    end

    subgraph GHA["GitHub App Event Routing (backend/src/bootstrap/probot-app.ts)"]
        A1["issues.opened, issues.edited<br/>runGitHubIssuePolicyCheck"]
        A2["pull_request.opened, edited, synchronize<br/>runGitHubPullRequestPolicyCheck"]
        A3["resolveGitHubPullRequestAutoReviewPolicy"]
        A4["pull_request.closed (merged)<br/>resolveGitHubReviewBehaviorPolicy"]
        A5["issue_comment.created (PR + Issue)<br/>handleGitHubIssueCommentCommand"]
        A6["pull_request_review_thread<br/>recordGitHubFeedbackSignal"]
    end

    subgraph GHW["Plain GitHub Webhook (backend/src/integrations/github/webhooks/handler.ts)"]
        B1["handlePlainGitHubWebhook"]
        B2["verifyWebhookSignature + payload schema"]
        B3["pull_request / issues / issue_comment / review_thread dispatch"]
        B4["runGitHubPullRequestPolicyCheck + runGitHubIssuePolicyCheck"]
        B5["handleGitHubIssueCommentCommand"]
    end

    subgraph GLW["GitLab Webhook (backend/src/integrations/gitlab/webhooks/adapter.ts)"]
        C1["runGitLabWebhook"]
        C2["verify token + payload schema"]
        C3["handleGitLabMergeRequestWebhook"]
        C4["handleGitLabNoteWebhook"]
        C5["resolveGitLabReviewPolicy (.pr-agent.yml)"]
    end

    subgraph CMD["Command Parsing Surface"]
        D1["parseReviewCommand"]
        D2["parseAsk / parseMention / parseChecks / parseGenerateTests"]
        D3["parseDescribe / parseChangelog"]
        D4["parseImprove / parseAddDoc / parseReflect / parseSimilarIssue / parseFeedback"]
    end

    subgraph CORE["Common Review Engine"]
        R1["runGitHubReview / runGitLabReview"]
        R2["dedupe + rate-limit + incremental head + feedback signals"]
        R3["collect context: diff/files/ci/policy"]
        R4["analyzePullRequest / answerPullRequestQuestion"]
        R5["patch parser + hunk prioritize + line mapping"]
        R6["secret scan + auto label"]
    end

    subgraph OUT["Output + Ops"]
        O1["buildReportCommentMarkdown"]
        O2["buildIssueCommentMarkdown"]
        O3["createComment / notes / managed upsert"]
        O4["publishNotification (optional)"]
        O5["pr_agent_* metrics + replay store"]
    end

    E1 --> A1
    E1 --> A2 --> A3 --> R1
    E1 --> A4 --> R1
    E1 --> A5
    E1 --> A6

    E2 --> B1 --> B2 --> B3
    B3 --> B4 --> R1
    B3 --> B5

    E3 --> C1 --> C2
    C2 --> C3 --> C5 --> R1
    C2 --> C4 --> C5

    A5 --> D1
    A5 --> D2
    A5 --> D3
    A5 --> D4
    B5 --> D1
    B5 --> D2
    B5 --> D3
    B5 --> D4
    C4 --> D1
    C4 --> D2
    C4 --> D3
    C4 --> D4

    D1 --> R1
    D2 --> R4
    D3 --> R4
    D4 --> R1

    R1 --> R2 --> R3 --> R4 --> R5
    R4 --> R6
    R5 --> O1 --> O3
    R5 --> O2 --> O3
    R6 --> O3
    O3 --> O4

    E4 --> B1
    E4 --> C1
    E5 --> O5
    E2 --> O5
    E3 --> O5
    O3 -. feedback signals .-> R2
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
│   │   ├── model/                   # Model contracts, providers, concurrency and health
│   │   ├── review/                  # Standard/deep review, strategy and rendering
│   │   ├── commands/                # Command parsing, Ask sessions and orchestration
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
├── data/                           # Local/runtime persisted state mount
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
- Persistent backend state defaults to `/data/pr-agent/...` inside containers and `data/pr-agent/...` on the host.

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
curl http://localhost:3000/ready              # Checks enabled runtime dependencies
curl http://localhost:3000/github/health       # GitHub config status
```

---

## Configuration

### Environment Variables

Copy `.env.example` and fill in the required values. The supported minimal configuration is:

- `.env.github-app.min.example` — GitHub App minimum

Legacy minimal examples for plain GitHub Webhook and GitLab remain in the repository for reference only; they are not part of the supported beta deployment path.

### AI Provider

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
| `HEALTHCHECK_AI_TIMEOUT_MS` | `5000` (5s) | Timeout for deep health check AI probe |
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
| `GITHUB_MERGED_DEDUPE_TTL_MS` | `86400000` (24h) | Dedup window for merged + report events |
| `GITHUB_FEEDBACK_SIGNAL_TTL_MS` | `2592000000` (30d) | Feedback signal retention window |
| `GITHUB_INCREMENTAL_STATE_TTL_MS` | `604800000` (7d) | Incremental review SHA cache lifetime |
| `GITHUB_POLICY_CONFIG_CACHE_TTL_MS` | `300000` (5min) | `.pr-agent.yml` cache for policy/review behavior |
| `GITHUB_WEBHOOK_MAX_BODY_BYTES` | `10485760` (10MB) | Extra hard cap for `/github/trigger` payload size |
| `GITHUB_WEBHOOK_SKIP_SIGNATURE` | `false` | Debug-only signature bypass; forbidden when `NODE_ENV=production` |

**GitLab-specific**

| Variable | Default | Description |
|---|---|---|
| `GITLAB_MERGED_DEDUPE_TTL_MS` | `86400000` (24h) | Merged + report event dedup window |
| `GITLAB_INCREMENTAL_STATE_TTL_MS` | `604800000` (7d) | Incremental review SHA cache |
| `GITLAB_FEEDBACK_SIGNAL_TTL_MS` | `2592000000` (30d) | Feedback learning signal retention |
| `GITLAB_POLICY_CONFIG_CACHE_TTL_MS` | `300000` (5min) | `.pr-agent.yml` policy cache |
| `GITLAB_WEBHOOK_MAX_BODY_BYTES` | `10485760` (10MB) | Extra hard cap for `/gitlab/trigger` payload size |
| `GITLAB_WEBHOOK_SECRET` | Required for GitLab | Missing or incorrect webhook secrets are rejected; request headers cannot provide API credentials or override review policy |
| `ALLOW_INSECURE_GITLAB_HTTP` | `false` | Allow `http://` GitLab base URL for local testing only |

**Tuning guidance:**

- `MERGED_DEDUPE_TTL_MS` — Controls the dedup window for `merged + report` events to prevent duplicate reviews on webhook retries. Increase to `48h–72h` if you experience frequent webhook redelivery; decrease to `1h–6h` if you need faster re-trigger. This only affects merged auto-triggers; manual `/ai-review` commands use the short (5 min) dedup window.
- `FEEDBACK_SIGNAL_TTL_MS` — Controls how long review-thread resolved/unresolved signals are retained. Increase to `60–90d` for teams with slower review cadence; decrease to `7–14d` if review rules change frequently.
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

The application image does not embed PostgreSQL or initialize external database roles. A standalone container therefore requires a separately provisioned PostgreSQL database, restricted schema-owner/application roles, and a completed migration run. The one-container `all` role is for local evaluation. Production deployments run separate `web`, `worker`, and `recovery` instances; use Compose below when the platform does not already manage those processes.

For a registry release, Buildx creates one manifest containing both supported architectures. Publish the verifier operator under a separate tag because the normal application image intentionally has no Docker CLI:

```bash
docker buildx build --platform linux/amd64,linux/arm64 --target default \
  -t ghcr.io/OWNER/pr-agent:TAG --push .
docker buildx build --platform linux/amd64,linux/arm64 --target verifier \
  -t ghcr.io/OWNER/pr-agent-verifier:TAG --push .
```

Verify the manifest with `docker buildx imagetools inspect`. BuildKit provenance entries reported as `unknown/unknown` are attestations associated with the two images, not an additional runtime architecture.

### Docker Compose

Copy `.env.example` to `.env` and replace all placeholders. Compose requires four distinct, randomly generated PostgreSQL passwords and has no password fallbacks:

```env
HARNESS_BOOTSTRAP_PASSWORD=...
HARNESS_MIGRATION_PASSWORD=...
HARNESS_APP_PASSWORD=...
HARNESS_VERIFIER_PASSWORD=...
```

```bash
# Start
docker compose up -d --build

# View logs
docker compose logs -f pr-agent worker recovery

# Restart
docker compose restart pr-agent worker recovery

# Stop
docker compose down
```

The `docker-compose.yml` uses:

- `harness-postgres` — PostgreSQL business state and migration ledger
- `pr-agent` — the public `web` process only
- `worker` and `recovery` — independent durable execution processes
- `PRIVATE_KEY` — the default inline GitHub App PEM path, suitable for Coolify and other secret environment managers
- `docker-compose.secret-file.yml` — an optional PEM file overlay for hosts with a managed secret file

On a fresh volume, PostgreSQL bootstraps restricted migrator, application, and verifier roles. The one-shot `database-init` service applies the schema before the three application roles start. Changing `.env` does not rotate passwords in an existing volume. Volumes created by the former superuser `pr_agent_migrator` layout require the explicit, backed-up upgrade procedure in [backend/docs/operations.md](backend/docs/operations.md#旧-volume-角色升级); do not delete the volume or run the new migrator first.

Compose uses `.env` only for interpolation. The application service receives an explicit runtime allowlist rather than the whole file, so bootstrap, migration, and verifier credentials are not present in the application container.

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

1. **Use GitHub App integration mode** — this is the only supported integration in the current beta
2. **Configure AI provider** — Set `AI_PROVIDER` and the corresponding API key / model
3. **Initialize PostgreSQL** — For Compose, configure all four database passwords and require `database-init` to complete successfully; external PostgreSQL deployments must provision equivalent restricted roles before running the migration CLI
4. **Deploy the container** — Docker, Docker Compose, Render, Railway, Fly.io, or K8s
5. **Set webhook URL** to `https://<domain>/api/github/webhooks`
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
```

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

### GitHub App (Only Supported Mode)

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
```

- GitHub App enablement condition (see `backend/src/bootstrap/github-app/github-app-bootstrap.service.ts`): `APP_ID` + (`PRIVATE_KEY` or `PRIVATE_KEY_PATH`) + `WEBHOOK_SECRET`.
- Base `docker-compose.yml` uses inline `PRIVATE_KEY` and does not require a host PEM, which is the Coolify-compatible path. The optional `docker-compose.secret-file.yml` overlay creates the file secret from `./secrets/github-app.private-key.pem`; on Linux, provision it for UID/GID `10001:10001` with mode `0400` before starting the overlay.
- For the optional file overlay, create only the managed secret directory: `mkdir -p secrets`.

> If `APP_ID` + `PRIVATE_KEY` (+ `WEBHOOK_SECRET`) are not configured, GitHub App mode is disabled and the beta deployment is considered incomplete.

### Unsupported Integrations In Current Beta

- Plain GitHub Webhook is not a supported deployment target right now.
- GitLab Webhook is not a supported deployment target right now.

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
| `customRules` | Team-specific review rules (natural language); enforced in both reviews and Q&A |

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
| `GET /health` | Liveness probe |
| `GET /ready` | Readiness for enabled capabilities and runtime dependencies |
| `GET /github/health` | GitHub webhook config validation |
| `GET /gitlab/health` | Legacy GitLab webhook config validation (unsupported in current beta) |

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
- **Deduplication**: FNV hash with 5-min window (24h for merged events)
- **Rate Limiting**: per-scope limits to prevent API abuse
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

# Frontend production build check
pnpm --filter frontend build
```

Backend tests use the Node.js built-in test runner (`node:test`). Recommended regression coverage includes:
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
