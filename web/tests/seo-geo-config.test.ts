import assert from "node:assert/strict";
import test from "node:test";

import seoGeo from "../lib/seo-geo.ts";

type JsonLdNode = Record<string, unknown>;
type SeoGeoModule = {
  SITE_URL: string;
  DEFAULT_LOCALE: "en" | "zh";
  getLocalePath: (locale: "en" | "zh") => "/en" | "/zh";
  getLocaleAlternates: () => {
    canonical: Record<"en" | "zh", string>;
    languages: Record<"en-US" | "zh-CN" | "x-default", string>;
  };
  buildJsonLdGraphForLocale: (locale: "en" | "zh") => JsonLdNode[];
  buildLlmsTxt: () => string;
};

const {
  SITE_URL,
  DEFAULT_LOCALE,
  getLocalePath,
  getLocaleAlternates,
  buildJsonLdGraphForLocale,
  buildLlmsTxt,
} = seoGeo as SeoGeoModule;

test("site URL is canonical https domain", () => {
  assert.equal(SITE_URL, "https://pr-agent.condevtools.com");
});

test("json-ld graph includes website organization software application and faq page", () => {
  const graph = buildJsonLdGraphForLocale("en");
  const types = graph.map((node) => node["@type"]);

  assert.ok(types.includes("WebSite"));
  assert.ok(types.includes("Organization"));
  assert.ok(types.includes("SoftwareApplication"));
  assert.ok(types.includes("FAQPage"));
});

test("default english faq uses english question text", () => {
  const faq = buildJsonLdGraphForLocale("en").find((node) => node["@type"] === "FAQPage");

  assert.ok(faq);
  const questions = (faq.mainEntity as Array<{ name: string }>).map((entry) => entry.name);

  assert.ok(questions.some((question) => question.includes("What is PR Agent")));
  assert.ok(questions.every((question) => !question.includes("PR Agent 是什么")));
});

test("zh locale faq uses chinese question text", () => {
  const faq = buildJsonLdGraphForLocale("zh").find((node) => node["@type"] === "FAQPage");

  assert.ok(faq);
  const questions = (faq.mainEntity as Array<{ name: string }>).map((entry) => entry.name);

  assert.ok(questions.some((question) => question.includes("PR Agent 是什么")));
  assert.ok(questions.every((question) => !question.includes("What is PR Agent")));
});

test("llms text includes canonical url and citation guidance", () => {
  const text = buildLlmsTxt();

  assert.match(text, /PR Agent/);
  assert.match(text, /Canonical:\s+https:\/\/pr-agent\.condevtools\.com/);
  assert.match(text, /https:\/\/pr-agent\.condevtools\.com\/en/);
  assert.match(text, /https:\/\/pr-agent\.condevtools\.com\/zh/);
  assert.match(text, /Preferred citations/i);
});

test("locale routing defaults to english and supports en/zh paths", () => {
  assert.equal(DEFAULT_LOCALE, "en");
  assert.equal(getLocalePath("en"), "/en");
  assert.equal(getLocalePath("zh"), "/zh");
});

test("locale alternates expose hreflang mapping with x-default", () => {
  const alternates = getLocaleAlternates();

  assert.deepEqual(alternates.canonical, {
    en: "https://pr-agent.condevtools.com/en",
    zh: "https://pr-agent.condevtools.com/zh",
  });
  assert.deepEqual(alternates.languages, {
    "en-US": "https://pr-agent.condevtools.com/en",
    "zh-CN": "https://pr-agent.condevtools.com/zh",
    "x-default": "https://pr-agent.condevtools.com/en",
  });
});

test("localized json-ld pins software url to locale route", () => {
  const zhGraph = buildJsonLdGraphForLocale("zh");
  const softwareNode = zhGraph.find((node) => node["@type"] === "SoftwareApplication");

  assert.ok(softwareNode);
  assert.equal(softwareNode.url, "https://pr-agent.condevtools.com/zh");
});
