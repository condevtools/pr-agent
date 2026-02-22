import { routing } from "../i18n/routing";

export const SUPPORTED_LOCALES = routing.locales;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = routing.defaultLocale;

const LOCALE_PATHS: Record<SupportedLocale, "/en" | "/zh"> = {
  en: "/en",
  zh: "/zh",
};

export function isSupportedLocale(value: string): value is SupportedLocale {
  return SUPPORTED_LOCALES.includes(value as SupportedLocale);
}

export function getLocalePath(locale: SupportedLocale): "/en" | "/zh" {
  return LOCALE_PATHS[locale];
}

// Default export for Node.js test runner compatibility (tsx CJS interop)
export default {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  getLocalePath,
};
