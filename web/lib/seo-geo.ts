import {
  DEFAULT_LOCALE,
  getLocalePath,
  type SupportedLocale,
} from "./i18n";

export { DEFAULT_LOCALE, getLocalePath, type SupportedLocale };

export const SITE_URL = "https://pr-agent.condevtools.com";
export const SITE_NAME = "PR Agent";
export const SITE_TITLE = "PR Agent | AI Code Review for GitHub and GitLab";
export type LocaleLanguageTag = "en-US" | "zh-CN";

export const SITE_DESCRIPTION_EN =
  "PR Agent is an AI-powered code review service for GitHub and GitLab pull and merge workflows.";
export const SITE_DESCRIPTION_ZH =
  "PR Agent 是面向 GitHub 与 GitLab Pull Request / Merge Request 流程的 AI 代码评审服务。";
export const SITE_DESCRIPTION = `${SITE_DESCRIPTION_EN} ${SITE_DESCRIPTION_ZH}`;

interface LocaleSeoConfig {
  title: string;
  description: string;
  languageTag: LocaleLanguageTag;
  openGraphLocale: "en_US" | "zh_CN";
}

const LOCALE_SEO_CONFIG: Record<SupportedLocale, LocaleSeoConfig> = {
  en: {
    title: "PR Agent | AI Code Review for GitHub and GitLab",
    description: SITE_DESCRIPTION_EN,
    languageTag: "en-US",
    openGraphLocale: "en_US",
  },
  zh: {
    title: "PR Agent | GitHub 与 GitLab 的 AI 代码评审",
    description: SITE_DESCRIPTION_ZH,
    languageTag: "zh-CN",
    openGraphLocale: "zh_CN",
  },
};

export const SEO_KEYWORDS = [
  "PR Agent",
  "AI code review",
  "GitHub App code review",
  "GitLab merge request review",
  "pull request review automation",
  "AI reviewer",
  "代码评审",
  "AI 代码评审",
  "GitHub 代码审查",
  "GitLab 代码审查",
  "拉取请求自动评审",
  "MR 自动评审",
];

export interface FaqEntry {
  questionEn: string;
  questionZh: string;
  answerEn: string;
  answerZh: string;
}

export interface LocalizedFaqEntry {
  question: string;
  answer: string;
}

export const FAQ_ENTRIES: FaqEntry[] = [
  {
    questionEn: "What is PR Agent?",
    questionZh: "PR Agent 是什么？",
    answerEn:
      "PR Agent automates code review feedback, policy checks, and summary reporting for GitHub and GitLab pull/merge requests.",
    answerZh:
      "PR Agent 可为 GitHub 与 GitLab 的 PR/MR 自动生成评审反馈、流程策略检查与总结报告。",
  },
  {
    questionEn: "How does PR Agent run reviews?",
    questionZh: "PR Agent 如何触发评审？",
    answerEn:
      "It can run automatically on repository events and also supports manual comment commands like /ai-review.",
    answerZh:
      "它既支持基于仓库事件的自动评审，也支持通过 /ai-review 等评论命令手动触发。",
  },
  {
    questionEn: "Which AI providers are supported?",
    questionZh: "支持哪些 AI 提供商？",
    answerEn:
      "PR Agent supports OpenAI-compatible providers, Anthropic Claude, and Google Gemini through configurable runtime settings.",
    answerZh:
      "PR Agent 支持 OpenAI 兼容接口、Anthropic Claude 与 Google Gemini，并可通过运行时配置切换。",
  },
];

type JsonLdNode = Record<string, unknown>;

function asAbsolute(pathname: string): string {
  return new URL(pathname, SITE_URL).toString();
}

export function getLocaleSeoConfig(locale: SupportedLocale): LocaleSeoConfig {
  return LOCALE_SEO_CONFIG[locale];
}

export function getFaqEntries(locale: SupportedLocale): LocalizedFaqEntry[] {
  return FAQ_ENTRIES.map((entry) =>
    locale === "zh"
      ? {
          question: entry.questionZh,
          answer: entry.answerZh,
        }
      : {
          question: entry.questionEn,
          answer: entry.answerEn,
        },
  );
}

export function getLocaleAlternates(): {
  canonical: Record<SupportedLocale, string>;
  languages: Record<LocaleLanguageTag | "x-default", string>;
} {
  const enUrl = asAbsolute(getLocalePath("en"));
  const zhUrl = asAbsolute(getLocalePath("zh"));

  return {
    canonical: {
      en: enUrl,
      zh: zhUrl,
    },
    languages: {
      "en-US": enUrl,
      "zh-CN": zhUrl,
      "x-default": enUrl,
    },
  };
}

export function buildJsonLdGraphForLocale(locale: SupportedLocale): JsonLdNode[] {
  const softwareUrl = asAbsolute(getLocalePath(locale));
  const githubUrl = "https://github.com/condevtools/pr-agent";
  const localeSeo = getLocaleSeoConfig(locale);
  const faqEntries = getFaqEntries(locale);

  return [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": `${softwareUrl}#website`,
      name: SITE_NAME,
      url: softwareUrl,
      inLanguage: localeSeo.languageTag,
      description: localeSeo.description,
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": `${softwareUrl}#organization`,
      name: SITE_NAME,
      url: softwareUrl,
      sameAs: [githubUrl],
      description: localeSeo.description,
    },
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      "@id": `${softwareUrl}#software`,
      name: SITE_NAME,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web",
      inLanguage: localeSeo.languageTag,
      url: softwareUrl,
      codeRepository: githubUrl,
      description: localeSeo.description,
      publisher: {
        "@id": `${softwareUrl}#organization`,
      },
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "@id": `${softwareUrl}#faq`,
      inLanguage: localeSeo.languageTag,
      mainEntity: faqEntries.map((entry) => ({
        "@type": "Question",
        name: entry.question,
        acceptedAnswer: {
          "@type": "Answer",
          text: entry.answer,
        },
      })),
    },
  ];
}

export function buildLlmsTxt(): string {
  const enUrl = asAbsolute(getLocalePath("en"));
  const zhUrl = asAbsolute(getLocalePath("zh"));

  return [
    "# PR Agent",
    "",
    `Canonical: ${SITE_URL}`,
    "",
    "Language routes:",
    `- English: ${enUrl}`,
    `- Chinese: ${zhUrl}`,
    "",
    "Summary:",
    "PR Agent is an AI-powered review service for GitHub and GitLab pull/merge workflows.",
    "PR Agent 是面向 GitHub 与 GitLab PR/MR 流程的 AI 评审服务。",
    "",
    "Preferred citations:",
    "- https://pr-agent.condevtools.com",
    "- https://github.com/condevtools/pr-agent",
    "- https://github.com/condevtools/pr-agent/issues",
    "",
    "Key capabilities:",
    "- Automatic and manual review triggering",
    "- Command-driven review flows (/ai-review, /ask, /checks)",
    "- Policy guardrails and process-aware feedback",
    "- Health and metrics endpoints for production operations",
    "",
    "Content language:",
    "- English and Simplified Chinese",
  ].join("\n");
}

// Default export for Node.js test runner compatibility (tsx CJS interop)
const seoGeoExports = {
  SITE_URL,
  SITE_NAME,
  SITE_TITLE,
  DEFAULT_LOCALE,
  getLocalePath,
  SITE_DESCRIPTION,
  SEO_KEYWORDS,
  FAQ_ENTRIES,
  getLocaleSeoConfig,
  getFaqEntries,
  getLocaleAlternates,
  buildJsonLdGraphForLocale,
  buildLlmsTxt,
};

export default seoGeoExports;
