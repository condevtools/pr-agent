import { getAuth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

// Lazily build the handler on first request so the module can be imported
// without crashing when auth env vars are absent (e.g. during Next.js
// route collection at build time).
let _handler: ReturnType<typeof toNextJsHandler> | null = null;

function handler() {
  if (!_handler) {
    _handler = toNextJsHandler(getAuth());
  }
  return _handler;
}

export function GET(request: Request) {
  return handler().GET(request);
}

export function POST(request: Request) {
  return handler().POST(request);
}
