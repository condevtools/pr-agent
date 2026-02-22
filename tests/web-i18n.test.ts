import assert from "node:assert/strict";
import test from "node:test";

import i18n from "../web/lib/i18n.ts";
import routingModule from "../web/i18n/routing.ts";

const {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  getLocalePath,
} = i18n as {
  DEFAULT_LOCALE: "en" | "zh";
  SUPPORTED_LOCALES: readonly ("en" | "zh")[];
  isSupportedLocale: (value: string) => value is "en" | "zh";
  getLocalePath: (locale: "en" | "zh") => "/en" | "/zh";
};

const { routing } = routingModule as {
  routing: {
    locales: readonly [string, string];
    defaultLocale: string;
  };
};

test("i18n exposes default locale and supported locales", () => {
  assert.equal(DEFAULT_LOCALE, "en");
  assert.deepEqual([...SUPPORTED_LOCALES], ["en", "zh"]);
});

test("i18n locale guard works for valid and invalid values", () => {
  assert.equal(isSupportedLocale("en"), true);
  assert.equal(isSupportedLocale("zh"), true);
  assert.equal(isSupportedLocale("fr"), false);
});

test("i18n locale path mapping returns canonical paths", () => {
  assert.equal(getLocalePath("en"), "/en");
  assert.equal(getLocalePath("zh"), "/zh");
});

test("lib/i18n derives locales from i18n/routing (single source of truth)", () => {
  assert.deepEqual([...SUPPORTED_LOCALES], [...routing.locales]);
  assert.equal(DEFAULT_LOCALE, routing.defaultLocale);
});

test("next-intl routing config exposes locales and default locale", () => {
  assert.deepEqual([...routing.locales], ["en", "zh"]);
  assert.equal(routing.defaultLocale, "en");
});
