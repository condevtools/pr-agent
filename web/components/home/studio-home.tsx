import {
  DEFAULT_LOCALE,
  buildJsonLdGraphForLocale,
  type SupportedLocale,
} from "@/lib/seo-geo";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { InteractiveGrid } from "./interactive-grid";
import { MermaidArchitecture } from "./mermaid-architecture";
import { NavKeyboardShortcuts } from "./nav-keyboard-shortcuts";
import styles from "./studio-home.module.css";

type SectionId =
  | "overview"
  | "capabilities"
  | "commands"
  | "mermaid"
  | "operations"
  | "contact";

interface TableRow {
  cells: [string, string, string];
  monoColumns?: number[];
}

const navSections: SectionId[] = [
  "overview",
  "capabilities",
  "commands",
  "mermaid",
  "operations",
  "contact",
];

const platformBadges = [
  "GitHub App (Probot)",
  "GitHub Webhook",
  "GitLab Webhook",
  "OpenAI / Anthropic / Gemini",
];

const commandSyntax = [
  "/ai-review [report|comment]",
  "/ask <question>",
  "/checks [question]",
  "/generate_tests [focus]",
  "/describe [--apply]",
  "/changelog [--apply]",
  "/improve [focus]",
  "/add_doc [focus]",
  "/reflect [goal]",
  "/similar_issue [query]",
  "/feedback up|down|resolved|dismissed",
];

const commandKeys = [
  "aiReview",
  "ask",
  "checks",
  "generateTests",
  "describe",
  "changelog",
  "improve",
  "addDoc",
  "reflect",
  "similarIssue",
  "feedback",
];

const architectureSourcePaths = [
  "src/app.controller.ts + src/modules/*/webhook.controller.ts",
  "src/integrations/github/* + src/integrations/gitlab/*",
  "src/review/patch.ts + src/review/ai-reviewer.ts + src/review/report-renderer.ts",
];

const capabilitySourcePaths = [
  null,
  null,
  "src/integrations/github/github-review.ts",
  "README Features + src/review/ai-reviewer.ts",
];

const endpointPaths = [
  "GET /health",
  "GET /metrics",
  "GET /github/health",
  "GET /gitlab/health",
  "POST /github/trigger",
  "POST /gitlab/trigger",
  "GET /webhook/events",
  "POST /github/replay/:eventId",
  "POST /gitlab/replay/:eventId",
];

const endpointKeys = [
  "health",
  "metrics",
  "githubHealth",
  "gitlabHealth",
  "githubTrigger",
  "gitlabTrigger",
  "webhookEvents",
  "githubReplay",
  "gitlabReplay",
];

const observabilityMetrics = [
  "mr_agent_webhook_requests_total",
  "mr_agent_webhook_results_total",
  "mr_agent_webhook_replay_total",
  "mr_agent_health_checks_total",
  "mr_agent_ai_requests_active",
  "mr_agent_ai_wait_queue_size",
];

const contactLinks = [
  { key: "github", label: "GitHub", href: "https://github.com/condevtools/pr-agent" },
  { key: "issue", label: "Issue", href: "https://github.com/condevtools/pr-agent/issues" },
];

function PixelLogo() {
  const pattern = [
    [1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 1, 1, 1, 1],
  ];

  return (
    <div className={styles.pixelLogo} aria-hidden>
      {pattern.flat().map((cell, index) => (
        <span
          key={index}
          className={`${styles.pixelLogoCell} ${
            cell ? styles.pixelLogoCellFilled : styles.pixelLogoCellEmpty
          }`}
        />
      ))}
    </div>
  );
}

function MatrixTable(props: { headers: [string, string, string]; rows: TableRow[] }) {
  const { headers, rows } = props;
  return (
    <div className={styles.tableWrap}>
      <div className={styles.tableHeader}>
        {headers.map((header) => (
          <div key={header} className={styles.tableHeaderCell}>
            {header}
          </div>
        ))}
      </div>
      {rows.map((row) => (
        <div key={row.cells.join("|")} className={styles.tableRow}>
          {row.cells.map((cell, index) => (
            <div
              key={`${row.cells[0]}-${index}`}
              data-label={headers[index]}
              className={`${styles.tableCell} ${
                row.monoColumns?.includes(index) ? styles.tableCellMono : ""
              }`}
            >
              {cell}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

interface StudioHomeProps {
  locale?: SupportedLocale;
}

export function StudioHome({ locale = DEFAULT_LOCALE }: StudioHomeProps) {
  const t = useTranslations("Home");

  const navItems = navSections.map((section) => ({
    section,
    label: t(`nav.${section}`),
  }));

  const architectureRows: TableRow[] = [
    { cells: [t("architecture.ingress.0"), t("architecture.ingress.1"), architectureSourcePaths[0]], monoColumns: [2] },
    { cells: [t("architecture.integration.0"), t("architecture.integration.1"), architectureSourcePaths[1]], monoColumns: [2] },
    { cells: [t("architecture.reviewEngine.0"), t("architecture.reviewEngine.1"), architectureSourcePaths[2]], monoColumns: [2] },
  ];

  const capabilityRows: TableRow[] = [
    { cells: [t("capabilities.autoReview.0"), t("capabilities.autoReview.1"), t("capabilities.autoReview.2")] },
    { cells: [t("capabilities.policyGuardrails.0"), t("capabilities.policyGuardrails.1"), t("capabilities.policyGuardrails.2")] },
    { cells: [t("capabilities.securitySignals.0"), t("capabilities.securitySignals.1"), capabilitySourcePaths[2]!], monoColumns: [2] },
    { cells: [t("capabilities.processReview.0"), t("capabilities.processReview.1"), capabilitySourcePaths[3]!], monoColumns: [2] },
  ];

  const triggerRows: TableRow[] = [
    { cells: [t("triggers.prOpened.0"), t("triggers.prOpened.1"), t("triggers.prOpened.2")] },
    { cells: [t("triggers.prMerged.0"), t("triggers.prMerged.1"), t("triggers.prMerged.2")] },
    { cells: [t("triggers.commentCommands.0"), t("triggers.commentCommands.1"), t("triggers.commentCommands.2")] },
    { cells: [t("triggers.policyChecks.0"), t("triggers.policyChecks.1"), t("triggers.policyChecks.2")] },
  ];

  const commandRows: TableRow[] = commandKeys.map((key, i) => ({
    cells: [commandSyntax[i], t(`commands.${key}.0`), t(`commands.${key}.1`)],
    monoColumns: [0],
  }));

  const endpointRows: TableRow[] = endpointKeys.map((key, i) => ({
    cells: [endpointPaths[i], t(`operations.endpoints.${key}.0`), t(`operations.endpoints.${key}.1`)],
    monoColumns: [0],
  }));

  const structuredData = {
    "@context": "https://schema.org",
    "@graph": buildJsonLdGraphForLocale(locale),
  };

  return (
    <div className={styles.home}>
      <NavKeyboardShortcuts />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

      <InteractiveGrid />

      <nav className={styles.nav} aria-label={t("language.switch")}>
        {navItems.map((item) => (
          <a key={item.section} className={styles.navLink} href={`#${item.section}`}>
            {item.label}
          </a>
        ))}
        <div className={styles.navLocaleDivider} />
        <Link
          className={styles.navLink}
          href={locale === "en" ? "/zh" : "/en"}
          aria-label={t("language.switch")}
        >
          {locale === "en" ? t("language.zh") : t("language.en")}
        </Link>
      </nav>

      <main className={styles.stage} lang={locale === "zh" ? "zh-CN" : "en"}>
        <section id="overview" className={`${styles.contentCard} ${styles.heroCard}`}>
          <PixelLogo />
          <span className={styles.cardMeta}>{t("hero.tag")}</span>
          <h1 className={styles.cardSectionTitle}>PR Agent</h1>
          <h2 className={styles.cardDisplayTitle}>{t("hero.title")}</h2>
          <p className={styles.cardBodyText}>{t("hero.body")}</p>
          <div className={styles.pillRow}>
            {platformBadges.map((badge) => (
              <span key={badge} className={styles.pill}>
                {badge}
              </span>
            ))}
          </div>
          <div className={styles.metaGrid}>
            <div className={styles.metaCard}>
              <span className={styles.cardMeta}>{t("metaStats.platforms")}</span>
              <p className={styles.metricValue}>{t("metaStats.platformsValue")}</p>
            </div>
            <div className={styles.metaCard}>
              <span className={styles.cardMeta}>{t("metaStats.providers")}</span>
              <p className={styles.metricValue}>{t("metaStats.providersValue")}</p>
            </div>
            <div className={styles.metaCard}>
              <span className={styles.cardMeta}>{t("metaStats.tests")}</span>
              <p className={styles.metricValue}>{t("metaStats.testsValue")}</p>
            </div>
            <div className={styles.metaCard}>
              <span className={styles.cardMeta}>{t("metaStats.runtime")}</span>
              <p className={styles.metricValue}>{t("metaStats.runtimeValue")}</p>
            </div>
          </div>
        </section>

        <section className={`${styles.contentCard} ${styles.projectsCard}`}>
          <span className={styles.cardMeta}>{t("architecture.meta")}</span>
          <h2 className={styles.cardSectionTitle}>{t("architecture.title")}</h2>
          <MatrixTable
            headers={[t("architecture.headers.0"), t("architecture.headers.1"), t("architecture.headers.2")]}
            rows={architectureRows}
          />
        </section>

        <section className={`${styles.contentCard} ${styles.methodCard}`}>
          <h2 className={styles.cardSectionTitle}>{t("runtimeHighlights.title")}</h2>
          <ul className={styles.bulletList}>
            {[0, 1, 2, 3].map((i) => (
              <li key={i}>{t(`runtimeHighlights.items.${i}`)}</li>
            ))}
          </ul>
          <p className={styles.cardMonoLink}>DEFAULTS: PORT=3000 / WEBHOOK_BODY_LIMIT=1MB</p>
        </section>

        <section id="capabilities" className={`${styles.contentCard} ${styles.sectionCard}`}>
          <span className={styles.cardMeta}>{t("capabilities.meta")}</span>
          <h2 className={styles.cardSectionTitle}>{t("capabilities.title")}</h2>
          <h3 className={styles.cardDisplayTitle}>{t("capabilities.subtitle")}</h3>
          <MatrixTable
            headers={[t("capabilities.headers.0"), t("capabilities.headers.1"), t("capabilities.headers.2")]}
            rows={capabilityRows}
          />
        </section>

        <section className={`${styles.contentCard} ${styles.sectionCard}`}>
          <span className={styles.cardMeta}>{t("triggers.meta")}</span>
          <h2 className={styles.cardSectionTitle}>{t("triggers.title")}</h2>
          <MatrixTable
            headers={[t("triggers.headers.0"), t("triggers.headers.1"), t("triggers.headers.2")]}
            rows={triggerRows}
          />
        </section>

        <section id="commands" className={`${styles.contentCard} ${styles.sectionCard}`}>
          <span className={styles.cardMeta}>{t("commands.meta")}</span>
          <h2 className={styles.cardSectionTitle}>{t("commands.title")}</h2>
          <h3 className={styles.cardDisplayTitle}>{t("commands.subtitle")}</h3>
          <MatrixTable
            headers={[t("commands.headers.0"), t("commands.headers.1"), t("commands.headers.2")]}
            rows={commandRows}
          />
          <pre className={styles.codeBlock}>
            <code>{`/ai-review comment
/ask why this cache key can collide?
/checks flaky test on ci
/generate_tests diff parser edge cases
/changelog --apply release notes`}</code>
          </pre>
        </section>

        <section
          id="mermaid"
          className={`${styles.contentCard} ${styles.sectionCard} ${styles.mermaidSection}`}
        >
          <span className={styles.cardMeta}>{t("mermaid.meta")}</span>
          <h2 className={styles.cardSectionTitle}>{t("mermaid.title")}</h2>
          <h3 className={styles.cardDisplayTitle}>{t("mermaid.subtitle")}</h3>
          <MermaidArchitecture />
        </section>

        <section id="operations" className={`${styles.contentCard} ${styles.contactCard}`}>
          <span className={styles.cardMeta}>{t("operations.meta")}</span>
          <h2 className={styles.cardSectionTitle}>{t("operations.title")}</h2>
          <h3 className={styles.cardDisplayTitle}>{t("operations.subtitle")}</h3>

          <div className={styles.opsGrid}>
            <div className={styles.opsPanel}>
              <h3 className={styles.panelTitle}>{t("operations.quickStart")}</h3>
              <pre className={styles.codeBlock}>
                <code>{`npm install
npm run dev
curl http://localhost:3000/health
curl http://localhost:3000/metrics`}</code>
              </pre>
            </div>
            <div className={styles.opsPanel}>
              <h3 className={styles.panelTitle}>{t("operations.primaryEndpoints")}</h3>
              <MatrixTable
                headers={[t("operations.endpointHeaders.0"), t("operations.endpointHeaders.1"), t("operations.endpointHeaders.2")]}
                rows={endpointRows}
              />
            </div>
          </div>

          <div className={styles.opsGrid}>
            <div className={styles.opsPanel}>
              <h3 className={styles.panelTitle}>{t("operations.deploymentBaseline")}</h3>
              <ul className={styles.bulletList}>
                {[0, 1, 2, 3, 4].map((i) => (
                  <li key={i}>{t(`operations.deploymentChecklist.${i}`)}</li>
                ))}
              </ul>
            </div>
            <div className={styles.opsPanel}>
              <h3 className={styles.panelTitle}>{t("operations.prometheusMetrics")}</h3>
              <ul className={styles.bulletList}>
                {observabilityMetrics.map((metric) => (
                  <li key={metric}>
                    <code className={styles.inlineCode}>{metric}</code>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section id="contact" className={`${styles.contentCard} ${styles.methodCard}`}>
          <span className={styles.cardMeta}>{t("contact.meta")}</span>
          <h2 className={styles.cardSectionTitle}>{t("contact.title")}</h2>
          <ul className={styles.linkList}>
            {contactLinks.map((item) => (
              <li key={item.href}>
                <a
                  className={styles.externalLink}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {item.label}
                </a>
                <p className={styles.linkNote}>{t(`contact.${item.key}`)}</p>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
