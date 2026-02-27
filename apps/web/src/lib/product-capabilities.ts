export type Capability = {
  id: string;
  title: string;
  summary: string;
  category: "core" | "commands" | "guardrail" | "platform";
};

export type CommandCapability = {
  name: string;
  description: string;
  focus: string;
};

export const CORE_CAPABILITIES: readonly Capability[] = [
  {
    id: "auto-review",
    title: "Automatic AI Review",
    summary: "Runs on PR/MR open, update, edit, and merge with dedup protection.",
    category: "core",
  },
  {
    id: "inline-suggestions",
    title: "Inline Suggestions",
    summary: "Posts code suggestions directly into review threads with actionable fixes.",
    category: "core",
  },
  {
    id: "incremental-review",
    title: "Incremental Review",
    summary: "Only analyzes new commits since the last accepted review checkpoint.",
    category: "core",
  },
  {
    id: "secret-scan",
    title: "Secret Leak Scanning",
    summary: "Detects suspicious credentials and sensitive token patterns in diffs.",
    category: "guardrail",
  },
  {
    id: "policy-enforcement",
    title: "Policy Enforcement",
    summary: "Supports remind/enforce modes via .mr-agent.yml and status checks.",
    category: "guardrail",
  },
  {
    id: "label-automation",
    title: "Label & Risk Automation",
    summary: "Auto-generates labels and risk summaries from actual patch content.",
    category: "core",
  },
  {
    id: "multi-provider",
    title: "Multi-Provider LLM",
    summary: "OpenAI, Anthropic, Gemini, and OpenAI-compatible endpoints.",
    category: "platform",
  },
  {
    id: "multi-platform",
    title: "GitHub + GitLab",
    summary: "GitHub App, plain webhook, and GitLab webhook support in one service.",
    category: "platform",
  },
];

export const COMMAND_CAPABILITIES: readonly CommandCapability[] = [
  {
    name: "/ai-review",
    description: "Run manual review in comment or report mode.",
    focus: "Review execution",
  },
  {
    name: "/ask",
    description: "Multi-turn code Q&A grounded in the current diff.",
    focus: "Developer assistant",
  },
  {
    name: "/checks",
    description: "Investigate CI failure context and suggest fixes.",
    focus: "CI triage",
  },
  {
    name: "/generate_tests",
    description: "Generate targeted tests based on changed files.",
    focus: "Test coverage",
  },
  {
    name: "/changelog",
    description: "Draft changelog entries with optional apply mode.",
    focus: "Release ops",
  },
  {
    name: "/describe",
    description: "Draft PR/MR descriptions with structure and risk notes.",
    focus: "PR quality",
  },
  {
    name: "/compliance",
    description: "Security/compliance-focused pass for regulated repos.",
    focus: "Compliance",
  },
  {
    name: "/similar_issue",
    description: "Retrieve related issues and summarize overlap.",
    focus: "Triage acceleration",
  },
];

export const REVIEW_TRIGGERS: readonly { event: string; mode: string; window: string }[] = [
  { event: "PR Opened", mode: "comment/report", window: "5 min" },
  { event: "PR Updated", mode: "comment/report", window: "5 min + SHA" },
  { event: "PR Edited", mode: "comment/report", window: "5 min" },
  { event: "PR Merged", mode: "report", window: "24h" },
  { event: "Manual /ai-review", mode: "comment/report", window: "5 min" },
  { event: "GitLab x-ai-mode", mode: "header override", window: "5 min" },
];

export const PLATFORM_SUPPORT: readonly { name: string; status: string; note: string }[] = [
  {
    name: "GitHub App",
    status: "recommended",
    note: "Full review + policy + webhook workflow",
  },
  {
    name: "GitHub Webhook",
    status: "available",
    note: "Lighter integration path for existing infra",
  },
  {
    name: "GitLab Webhook",
    status: "available",
    note: "MR review with mode override support",
  },
];
