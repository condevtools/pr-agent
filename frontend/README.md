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

The following diagram shows the full request flow of the PR Agent backend — from webhook entry points through command parsing, the common review engine, and output delivery.

```mermaid
flowchart LR
    subgraph E["Entry Endpoints (NestJS + Probot)"]
        E1["/api/github/webhooks<br/>GithubAppBootstrapService"]
        E2["/github/trigger<br/>GithubWebhookController"]
        E3["/gitlab/trigger<br/>GitlabWebhookController"]
        E4["/github/replay/:eventId<br/>/gitlab/replay/:eventId"]
        E5["/health /metrics /webhook/events"]
    end

    subgraph GHA["GitHub App Event Routing (src/app.ts)"]
        A1["issues.opened, issues.edited<br/>runGitHubIssuePolicyCheck"]
        A2["pull_request.opened, edited, synchronize<br/>runGitHubPullRequestPolicyCheck"]
        A3["resolveGitHubPullRequestAutoReviewPolicy"]
        A4["pull_request.closed (merged)<br/>resolveGitHubReviewBehaviorPolicy"]
        A5["issue_comment.created (PR + Issue)<br/>handleGitHubIssueCommentCommand"]
        A6["pull_request_review_thread<br/>recordGitHubFeedbackSignal"]
    end

    subgraph GHW["Plain GitHub Webhook (src/integrations/github/github-webhook.ts)"]
        B1["handlePlainGitHubWebhook"]
        B2["verifyWebhookSignature + payload schema"]
        B3["pull_request / issues / issue_comment / review_thread dispatch"]
        B4["runGitHubPullRequestPolicyCheck + runGitHubIssuePolicyCheck"]
        B5["handleGitHubIssueCommentCommand"]
    end

    subgraph GLW["GitLab Webhook (src/integrations/gitlab/gitlab-review.ts)"]
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
