import Link from "next/link";
import { headers } from "next/headers";

type IconProps = { className?: string };

function ScanSearch({ className }: IconProps) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.5 15.5 20 20M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13Z" />
    </svg>
  );
}

function MessageSquareCode({ className }: IconProps) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 10h10M7 14h6m-8 6 3-3h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 1 2Z" />
    </svg>
  );
}

function ShieldCheck({ className }: IconProps) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3 4 7v6c0 5 3.5 7.5 8 8 4.5-.5 8-3 8-8V7l-8-4Zm-3.5 9.5L11 15l4.5-5" />
    </svg>
  );
}

function GitPullRequestArrow({ className }: IconProps) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm0 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm0-6v6m5-6h6m0 0-2-2m2 2-2 2" />
    </svg>
  );
}

function CodeXml({ className }: IconProps) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m8 8-4 4 4 4m8-8 4 4-4 4m-3-10-2 12" />
    </svg>
  );
}

function BrainCircuit({ className }: IconProps) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 4a3 3 0 0 0-3 3v1a2.5 2.5 0 0 0 0 5V14a3 3 0 0 0 3 3m6-13a3 3 0 0 1 3 3v1a2.5 2.5 0 0 1 0 5V14a3 3 0 0 1-3 3M9 10h6M9 14h6m-3-4v8" />
    </svg>
  );
}

// rendering-hoist-jsx: hoist static data to module scope
const HEADER_NAV_ITEMS = ["features", "how_it_works", "pricing", "docs"] as const;
const METRICS = [
  { value: "50k+", label: "// prs_reviewed" },
  { value: "2,400+", label: "// repos_connected" },
  { value: "< 30s", label: "// avg_review_time" },
  { value: "94%", label: "// suggestion_accuracy" },
] as const;
const TESTIMONIALS = [
  {
    quote:
      '"pr-agent cut our review cycle from 2 days to 4 hours. the security checks alone saved us from shipping two critical vulnerabilities."',
    name: "sarah_chen  //  staff engineer @ stripe",
  },
  {
    quote:
      '"we use it on every repo. the ai actually understands our codebase patterns. it\'s like having a senior engineer on every pr."',
    name: "alex_rivera  //  eng lead @ vercel",
  },
  {
    quote:
      '"onboarding new devs used to mean weeks of inconsistent reviews. pr-agent enforces our standards from day one."',
    name: "marcus_j  //  vp eng @ linear",
  },
] as const;
type PricingTier = {
  name: string;
  nameColor?: string;
  badge?: string;
  price: string;
  period: string;
  features: readonly string[];
  featureColor: string;
  btnLabel: string;
  btnVariant: "primary" | "outline";
  highlighted?: boolean;
};
const PRICING_TIERS: readonly PricingTier[] = [
  {
    name: "$ free",
    price: "$0",
    period: "// per_month",
    features: [
      "✓  5 repos",
      "✓  50 reviews/month",
      "✓  basic security scan",
      "✓  community support",
    ],
    featureColor: "text-[var(--color-gray-muted)]",
    btnLabel: "$ install --free",
    btnVariant: "outline",
  },
  {
    name: "$ pro",
    nameColor: "text-[var(--color-emerald)]",
    badge: "popular",
    price: "$29",
    period: "// per_seat/month",
    features: [
      "✓  unlimited repos",
      "✓  unlimited reviews",
      "✓  advanced security + sast",
      "✓  custom review rules",
      "✓  slack + jira integration",
      "✓  priority support",
    ],
    featureColor: "text-[#FAFAFA]",
    btnLabel: "$ upgrade --pro",
    btnVariant: "primary",
    highlighted: true,
  },
  {
    name: "$ enterprise",
    price: "custom",
    period: "// contact_sales",
    features: [
      "✓  everything in pro",
      "✓  self-hosted deployment",
      "✓  sso + saml",
      "✓  audit logs + compliance",
      "✓  dedicated support",
      "✓  custom model training",
    ],
    featureColor: "text-[var(--color-gray-muted)]",
    btnLabel: "$ contact --sales",
    btnVariant: "outline",
  },
];
const FOOTER_COLUMNS = [
  {
    title: "// product",
    links: ["features", "pricing", "changelog", "integrations"],
  },
  {
    title: "// resources",
    links: ["documentation", "api_reference", "blog", "status"],
  },
  {
    title: "// company",
    links: ["about", "careers", "privacy", "terms"],
  },
] as const;
const FOOTER_SOCIALS = [
  { label: "github", href: "https://github.com/condevtools/mr-agent" },
  { label: "twitter", href: "https://x.com" },
  { label: "discord", href: "https://discord.com" },
] as const;

/* ─── Header ─── */
function Header({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="flex h-[72px] w-full items-center justify-between border-b border-[var(--color-terminal-border)] px-16">
      {/* Logo */}
      <div className="flex items-center gap-2.5">
        <span className="font-jetbrains text-[22px] font-bold text-[var(--color-emerald)]">
          {">"}_
        </span>
        <span className="font-jetbrains text-[18px] font-medium text-[#FAFAFA]">mr-agent</span>
      </div>

      {/* Nav */}
      <nav className="flex items-center gap-8">
        {HEADER_NAV_ITEMS.map((item) => (
          <a
            key={item}
            href={`#${item}`}
            className="font-jetbrains text-[13px] text-[var(--color-gray-muted)] transition-colors hover:text-[#FAFAFA]"
          >
            {item}
          </a>
        ))}
      </nav>

      {/* Right */}
      <div className="flex items-center gap-3">
        <a
          href="https://github.com/condevtools/pr-agent"
          target="_blank"
          rel="noreferrer"
          className="font-jetbrains text-[13px] text-[var(--color-gray-muted)] transition-colors hover:text-[#FAFAFA]"
        >
          $ github
        </a>
        {signedIn ? (
          <Link
            href="/dashboard"
            className="font-jetbrains rounded-none bg-[var(--color-emerald)] px-5 py-2 text-[12px] font-medium text-[#0A0A0A] transition-opacity hover:opacity-90"
          >
            open_dashboard
          </Link>
        ) : (
          <>
            <Link
              href="/login"
              className="font-jetbrains rounded-none border border-[var(--color-terminal-border)] px-4 py-2 text-[12px] text-[#FAFAFA] transition-colors hover:border-[var(--color-emerald)]"
            >
              sign_in
            </Link>
            <Link
              href="/login"
              className="font-jetbrains rounded-none bg-[var(--color-emerald)] px-5 py-2 text-[12px] font-medium text-[#0A0A0A] transition-opacity hover:opacity-90"
            >
              get_started
            </Link>
          </>
        )}
      </div>
    </header>
  );
}

/* ─── Hero ─── */
function HeroSection({ signedIn }: { signedIn: boolean }) {
  return (
    <section className="flex w-full flex-col items-center gap-10 px-[120px] pb-20 pt-[100px]">
      {/* Badge */}
      <div className="flex items-center gap-2 border border-[#10B98133] px-4 py-1.5">
        <span className="inline-block h-2 w-2 rounded-full bg-[var(--color-emerald)]" />
        <span className="font-jetbrains text-[12px] text-[var(--color-emerald)]">
          {"// now with auto-review v2.0"}
        </span>
      </div>

      {/* Text block */}
      <div className="flex w-full flex-col items-center gap-6">
        <h1 className="font-jetbrains text-center text-[64px] font-bold leading-[1.1] text-[#FAFAFA]">
          your code reviews,
          <br />
          on autopilot.
        </h1>
        <p className="font-ibm-plex max-w-[800px] text-center text-[18px] text-[var(--color-gray-muted)]">
          an ai agent that reviews pull requests, suggests fixes, answers
          questions, and manages issues — directly in your github workflow.
        </p>
      </div>

      {/* CTA Row */}
      <div className="flex items-center gap-4">
        <Link
          href={signedIn ? "/dashboard" : "/login"}
          className="flex items-center gap-2 bg-[var(--color-emerald)] px-8 py-3.5 transition-opacity hover:opacity-90"
        >
          <span className="font-jetbrains text-[14px] font-bold text-[#0A0A0A]">
            $
          </span>
          <span className="font-jetbrains text-[14px] font-medium text-[#0A0A0A]">
            install on github
          </span>
        </Link>
        <a
          href="https://github.com/condevtools/mr-agent"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 border border-[var(--color-terminal-border)] px-8 py-3.5 transition-colors hover:border-[var(--color-gray-muted)]"
        >
          <span className="font-jetbrains text-[14px] text-[#FAFAFA]">
            view docs →
          </span>
        </a>
      </div>

      {/* Terminal Mockup */}
      <div className="w-[900px] border border-[var(--color-terminal-border)] bg-[var(--color-terminal-bg)]">
        {/* Title bar */}
        <div className="flex h-10 items-center gap-2 border-b border-[var(--color-terminal-border)] px-4">
          <span className="h-2.5 w-2.5 rounded-full bg-[#EF4444]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#F59E0B]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-emerald)]" />
          <span className="font-jetbrains ml-2 text-[12px] text-[var(--color-gray-muted)]">
            pr-agent — review #847
          </span>
        </div>
        {/* Code block */}
        <div className="flex flex-col gap-1.5 p-6">
          <CodeLine color="emerald">
            {">"} analyzing pull request #847...
          </CodeLine>
          <CodeLine color="gray">
            {"  "}scanning 12 files changed, 847 additions, 234 deletions
          </CodeLine>
          <CodeLine color="gray">&nbsp;</CodeLine>
          <CodeLine color="dim">{"// code_review_summary"}</CodeLine>
          <CodeLine color="amber">
            {"  [security]  found 2 potential sql injection risks in /api/users.ts"}
          </CodeLine>
          <CodeLine color="cyan">
            {"  [style]     3 functions exceed 50 lines — consider refactoring"}
          </CodeLine>
          <CodeLine color="amber">
            {"  [perf]      n+1 query detected in getUserPosts()"}
          </CodeLine>
          <CodeLine color="emerald">
            {"  [ok]        test coverage: 94% (+2.3%)"}
          </CodeLine>
          <CodeLine color="gray">&nbsp;</CodeLine>
          <CodeLine color="emerald">
            {">"} posting review comments to github...
          </CodeLine>
          <CodeLine color="emerald">
            {"  ✓ 6 inline suggestions posted"}
          </CodeLine>
          <CodeLine color="emerald">
            {"  ✓ summary comment added to pr #847"}
          </CodeLine>
          <CodeLine color="white">
            {'  ✓ labels applied: [needs-review] [security-concern]'}
          </CodeLine>
        </div>
      </div>
    </section>
  );
}

// rendering-hoist-jsx: hoist static colorMap outside component
const CODE_LINE_COLORS = {
  emerald: "text-[var(--color-emerald)]",
  gray: "text-[var(--color-gray-muted)]",
  dim: "text-[var(--color-gray-dim)]",
  amber: "text-[#F59E0B]",
  cyan: "text-[#06B6D4]",
  white: "text-[#FAFAFA]",
} as const;

function CodeLine({
  children,
  color,
}: {
  children: React.ReactNode;
  color: keyof typeof CODE_LINE_COLORS;
}) {
  return (
    <span className={`font-jetbrains text-[13px] ${CODE_LINE_COLORS[color]}`}>
      {children}
    </span>
  );
}

/* ─── Trust Logos ─── */
// rendering-hoist-jsx: hoist static data to module scope
const TRUST_BRANDS = ["stripe", "vercel", "linear", "supabase", "notion", "figma"] as const;

function TrustLogos() {
  return (
    <section className="flex w-full flex-col items-center gap-6 px-[120px] py-10">
      <span className="font-jetbrains text-[12px] text-[var(--color-gray-dim)]">
        {"// trusted_by engineering teams at"}
      </span>
      <div className="flex w-full items-center justify-center gap-12">
        {TRUST_BRANDS.map((b) => (
          <span
            key={b}
            className="font-jetbrains text-[16px] font-medium text-[var(--color-gray-dark)]"
          >
            {b}
          </span>
        ))}
      </div>
    </section>
  );
}

// rendering-hoist-jsx: hoist static JSX element
const DIVIDER = <div className="h-px w-full bg-[var(--color-terminal-border)]" />;

/* ─── How It Works ─── */
// rendering-hoist-jsx: hoist static data to module scope
const HOW_IT_WORKS_STEPS = [
  {
    num: "01",
    title: "$ install",
    desc: "add pr-agent as a github app to your repository. one-click install, zero config files.",
  },
  {
    num: "02",
    title: "$ review",
    desc: "every pr triggers an automatic review. get inline comments, security checks, and suggestions.",
  },
  {
    num: "03",
    title: "$ merge",
    desc: "merge with confidence. every issue flagged, every suggestion applied. ship clean code faster.",
  },
] as const;

function HowItWorks() {
  return (
    <section
      id="how_it_works"
      className="flex w-full flex-col items-center gap-16 px-[120px] py-20"
    >
      <div className="flex w-full flex-col items-center gap-4">
        <span className="font-jetbrains text-[12px] text-[var(--color-emerald)]">
          {"// how_it_works"}
        </span>
        <h2 className="font-jetbrains text-center text-[42px] font-bold leading-[1.15] text-[#FAFAFA]">
          three commands to
          <br />
          better code reviews.
        </h2>
        <p className="font-ibm-plex text-center text-[16px] text-[var(--color-gray-muted)]">
          install once, runs on every pull request — no configuration needed.
        </p>
      </div>
      <div className="flex w-full gap-6">
        {HOW_IT_WORKS_STEPS.map((s) => (
          <div
            key={s.num}
            className="flex flex-1 flex-col gap-5 border border-[var(--color-terminal-border)] p-8"
          >
            <span className="font-jetbrains text-[32px] font-bold text-[var(--color-emerald)]">
              {s.num}
            </span>
            <span className="font-jetbrains text-[16px] font-medium text-[#FAFAFA]">
              {s.title}
            </span>
            <p className="font-ibm-plex text-[13px] leading-[1.6] text-[var(--color-gray-muted)]">
              {s.desc}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ─── Features ─── */
const FEATURES = [
  {
    icon: ScanSearch,
    title: "pr_review",
    desc: "automatic line-by-line code review on every pull request. catches bugs, security issues, and style violations before humans even look at it.",
  },
  {
    icon: MessageSquareCode,
    title: "issue_management",
    desc: "auto-triage and label issues. answer questions, suggest related prs, and link duplicates — all powered by deep codebase understanding.",
  },
  {
    icon: ShieldCheck,
    title: "security_scan",
    desc: "detect vulnerabilities, hardcoded secrets, and unsafe patterns. integrated directly into the review flow with actionable fix suggestions.",
  },
  {
    icon: GitPullRequestArrow,
    title: "auto_describe",
    desc: 'generates pr descriptions, titles, and labels automatically from your diff. no more "update stuff" commit messages.',
  },
  {
    icon: CodeXml,
    title: "code_suggestions",
    desc: "one-click apply suggestions directly from pr comments. refactors, optimizations, and bug fixes ready to commit.",
  },
  {
    icon: BrainCircuit,
    title: "context_aware",
    desc: "understands your entire codebase, not just the diff. reviews consider architecture, patterns, and conventions your team follows.",
  },
] as const;

// rendering-hoist-jsx: pre-compute row indices to avoid slice() on each render
const FEATURE_ROWS = [FEATURES.slice(0, 3), FEATURES.slice(3, 6)] as const;

function FeaturesSection() {
  return (
    <section
      id="features"
      className="flex w-full flex-col items-center gap-16 px-[120px] py-20"
    >
      <div className="flex w-full flex-col items-center gap-4">
        <span className="font-jetbrains text-[12px] text-[var(--color-emerald)]">
          {"// core_features"}
        </span>
        <h2 className="font-jetbrains text-center text-[42px] font-bold leading-[1.15] text-[#FAFAFA]">
          everything your team needs
          <br />
          for automated code review.
        </h2>
      </div>
      <div className="flex w-full flex-col gap-6">
        {FEATURE_ROWS.map((row, i) => (
          <div key={i} className="flex w-full gap-6">
            {row.map((f) => (
              <div
                key={f.title}
                className="flex flex-1 flex-col gap-4 border border-[var(--color-terminal-border)] p-8"
              >
                <f.icon className="h-7 w-7 text-[var(--color-emerald)]" />
                <span className="font-jetbrains text-[16px] font-medium text-[#FAFAFA]">
                  {f.title}
                </span>
                <p className="font-ibm-plex text-[13px] leading-[1.6] text-[var(--color-gray-muted)]">
                  {f.desc}
                </p>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

/* ─── Metrics ─── */
function MetricsSection() {
  return (
    <section className="flex w-full flex-col items-center gap-16 px-[120px] py-20">
      <div className="flex w-full flex-col items-center gap-4">
        <span className="font-jetbrains text-[12px] text-[var(--color-emerald)]">
          {"// impact_metrics"}
        </span>
        <h2 className="font-jetbrains text-center text-[42px] font-bold leading-[1.15] text-[#FAFAFA]">
          the numbers speak
          <br />
          for themselves.
        </h2>
      </div>
      <div className="flex w-full gap-6">
        {METRICS.map((m) => (
          <div
            key={m.label}
            className="flex flex-1 flex-col items-center gap-3 border border-[var(--color-terminal-border)] p-8"
          >
            <span className="font-jetbrains text-[48px] font-bold text-[var(--color-emerald)]">
              {m.value}
            </span>
            <span className="font-jetbrains text-[13px] text-[var(--color-gray-muted)]">
              {m.label}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ─── Testimonials ─── */
function TestimonialsSection() {
  return (
    <section className="flex w-full flex-col items-center gap-12 px-[120px] py-20">
      <span className="font-jetbrains text-[12px] text-[var(--color-emerald)]">
        {"// what_devs_say"}
      </span>
      <div className="flex w-full gap-6">
        {TESTIMONIALS.map((t) => (
          <div
            key={t.name}
            className="flex flex-1 flex-col gap-5 border border-[var(--color-terminal-border)] p-8"
          >
            <p className="font-ibm-plex text-[14px] leading-[1.7] text-[#FAFAFA]">
              {t.quote}
            </p>
            <div className="flex items-center gap-3">
              <span className="inline-block h-2 w-2 rounded-full bg-[var(--color-emerald)]" />
              <span className="font-jetbrains text-[12px] text-[var(--color-gray-muted)]">
                {t.name}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ─── Pricing ─── */
function PricingSection() {
  return (
    <section
      id="pricing"
      className="flex w-full flex-col items-center gap-16 px-[120px] py-20"
    >
      <div className="flex w-full flex-col items-center gap-4">
        <span className="font-jetbrains text-[12px] text-[var(--color-emerald)]">
          {"// pricing"}
        </span>
        <h2 className="font-jetbrains text-center text-[42px] font-bold text-[#FAFAFA]">
          simple, transparent pricing.
        </h2>
        <p className="font-ibm-plex text-center text-[16px] text-[var(--color-gray-muted)]">
          start free. upgrade when your team needs more.
        </p>
      </div>

      <div className="flex w-full gap-6">
        {PRICING_TIERS.map((tier) => (
          <PricingCard key={tier.name} {...tier} />
        ))}
      </div>
    </section>
  );
}

function PricingCard({
  name,
  nameColor = "text-[#FAFAFA]",
  badge,
  price,
  period,
  features,
  featureColor,
  btnLabel,
  btnVariant,
  highlighted = false,
}: {
  name: string;
  nameColor?: string;
  badge?: string;
  price: string;
  period: string;
  features: readonly string[];
  featureColor: string;
  btnLabel: string;
  btnVariant: "primary" | "outline";
  highlighted?: boolean;
}) {
  return (
    <div
      className={`flex flex-1 flex-col gap-6 border p-8 ${
        highlighted
          ? "border-[var(--color-emerald)] bg-[#10B98108]"
          : "border-[var(--color-terminal-border)]"
      }`}
    >
      {/* Header */}
      <div className="flex w-full flex-col gap-2">
        <div className="flex items-center gap-3">
          <span className={`font-jetbrains text-[16px] font-medium ${nameColor}`}>
            {name}
          </span>
          {badge && (
            <span className="bg-[var(--color-emerald)] px-2 py-0.5 font-jetbrains text-[10px] font-medium text-[#0A0A0A]">
              {badge}
            </span>
          )}
        </div>
        <span className="font-jetbrains text-[36px] font-bold text-[#FAFAFA]">
          {price}
        </span>
        <span className="font-jetbrains text-[12px] text-[var(--color-gray-muted)]">
          {period}
        </span>
      </div>

      <div className="h-px w-full bg-[var(--color-terminal-border)]" />

      {/* Features */}
      <div className="flex flex-col gap-3">
        {features.map((f) => (
          <span key={f} className={`font-jetbrains text-[13px] ${featureColor}`}>
            {"  "}{f}
          </span>
        ))}
      </div>

      {/* Button */}
      <button
        className={`flex w-full items-center justify-center py-3 px-6 font-jetbrains text-[13px] transition-opacity hover:opacity-90 ${
          btnVariant === "primary"
            ? "bg-[var(--color-emerald)] font-medium text-[#0A0A0A]"
            : "border border-[var(--color-terminal-border)] text-[#FAFAFA]"
        }`}
      >
        {btnLabel}
      </button>
    </div>
  );
}

/* ─── Final CTA ─── */
function FinalCTA({ signedIn }: { signedIn: boolean }) {
  return (
    <section className="flex w-full flex-col items-center gap-8 px-[120px] py-[100px]">
      <h2 className="font-jetbrains text-center text-[48px] font-bold leading-[1.2] text-[#FAFAFA]">
        {">"} stop shipping bugs.
        <br />
        {"  "}start shipping confidence.
      </h2>
      <p className="font-ibm-plex text-center text-[16px] text-[var(--color-gray-muted)]">
        join 2,400+ repositories already using pr-agent.
      </p>
      <div className="flex items-center gap-4">
        <Link
          href={signedIn ? "/dashboard" : "/login"}
          className="flex items-center gap-2 bg-[var(--color-emerald)] px-10 py-4 transition-opacity hover:opacity-90"
        >
          <span className="font-jetbrains text-[14px] font-bold text-[#0A0A0A]">
            $
          </span>
          <span className="font-jetbrains text-[14px] font-medium text-[#0A0A0A]">
            get started free
          </span>
        </Link>
        <a
          href="https://github.com/condevtools/mr-agent"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 border border-[var(--color-terminal-border)] px-10 py-4 transition-colors hover:border-[var(--color-gray-muted)]"
        >
          <span className="font-jetbrains text-[14px] text-[#FAFAFA]">
            book a demo →
          </span>
        </a>
      </div>
      <span className="font-jetbrains text-[12px] text-[var(--color-gray-dim)]">
        {"// no credit card required  •  setup in 60 seconds  •  cancel anytime"}
      </span>
    </section>
  );
}

/* ─── Footer ─── */
function Footer() {
  return (
    <footer className="flex w-full flex-col gap-12 bg-[var(--color-footer-bg)] px-[120px] pt-[60px] pb-10">
      {/* Top */}
      <div className="flex w-full items-start justify-between">
        {/* Brand */}
        <div className="flex w-[300px] flex-col gap-4">
          <div className="flex items-center gap-2.5">
            <span className="font-jetbrains text-[20px] font-bold text-[var(--color-emerald)]">
              {">"}_
            </span>
            <span className="font-jetbrains text-[16px] font-medium text-[#FAFAFA]">mr-agent</span>
          </div>
          <p className="font-ibm-plex max-w-[280px] text-[13px] leading-[1.6] text-[var(--color-gray-muted)]">
            ai-powered code review agent for
            <br />
            github pull requests and issues.
          </p>
        </div>

        {/* Links */}
        <div className="flex gap-20">
          {FOOTER_COLUMNS.map((col) => (
            <div key={col.title} className="flex flex-col gap-4">
              <span className="font-jetbrains text-[12px] text-[var(--color-gray-dim)]">
                {col.title}
              </span>
              {col.links.map((link) => (
                <a
                  key={link}
                  href="#"
                  className="font-jetbrains text-[13px] text-[var(--color-gray-muted)] transition-colors hover:text-[#FAFAFA]"
                >
                  {link}
                </a>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Footer divider */}
      <div className="h-px w-full bg-[#1a1a1a]" />

      {/* Bottom */}
      <div className="flex w-full items-center justify-between">
        <span className="font-jetbrains text-[12px] text-[var(--color-gray-dim)]">
          © 2026 pr-agent. all rights reserved.
        </span>
        <div className="flex items-center gap-6">
          {FOOTER_SOCIALS.map((social) => (
            <a
              key={social.label}
              href={social.href}
              target="_blank"
              rel="noreferrer"
              className="font-jetbrains text-[12px] text-[var(--color-gray-muted)] transition-colors hover:text-[#FAFAFA]"
            >
              {social.label}
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
}

/* ─── Page ─── */
export default async function Home() {
  let signedIn = false;
  try {
    const { getAuth } = await import("@/lib/auth");
    const session = await getAuth().api.getSession({
      headers: await headers(),
    });
    signedIn = Boolean(session);
  } catch {
    // Auth not configured (missing env vars / no DB) – render as signed-out
  }

  return (
    <div className="flex min-h-screen w-full flex-col bg-[var(--color-page-bg)]">
      <Header signedIn={signedIn} />
      <HeroSection signedIn={signedIn} />
      <TrustLogos />
      {DIVIDER}
      <HowItWorks />
      {DIVIDER}
      <FeaturesSection />
      {DIVIDER}
      <MetricsSection />
      {DIVIDER}
      <TestimonialsSection />
      {DIVIDER}
      <PricingSection />
      {DIVIDER}
      <FinalCTA signedIn={signedIn} />
      {DIVIDER}
      <Footer />
    </div>
  );
}
