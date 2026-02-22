import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["en", "zh"],
  defaultLocale: "en",
  localePrefix: "always",
  localeDetection: false,
});

// Default export for Node.js test runner compatibility (tsx CJS interop)
const routingExports = { routing };

export default routingExports;
