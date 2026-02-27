import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { getDefaultDb } from "@mr-agent/db";
import { readRequiredEnv, resolveAppUrl } from "./env";

// ---------------------------------------------------------------------------
// Lazy singleton – avoids crashing at module-load when env vars are absent
// (e.g. the public landing page should render without BETTER_AUTH_SECRET).
// ---------------------------------------------------------------------------

let _auth: ReturnType<typeof betterAuth> | null = null;

function createAuth() {
  const db = getDefaultDb();
  if (!db) {
    throw new Error(
      "[web/auth] Cannot initialise auth: DATABASE_URL is not configured.",
    );
  }

  return betterAuth({
    baseURL: resolveAppUrl(),
    secret: readRequiredEnv("BETTER_AUTH_SECRET", {
      allowPlaceholderInNextBuild: true,
    }),
    database: prismaAdapter(db, { provider: "postgresql" }),
    socialProviders: {
      github: {
        clientId: readRequiredEnv("GITHUB_CLIENT_ID", {
          allowPlaceholderInNextBuild: true,
        }),
        clientSecret: readRequiredEnv("GITHUB_CLIENT_SECRET", {
          allowPlaceholderInNextBuild: true,
        }),
      },
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: true,
        schema: {
          organization: {
            additionalFields: {
              plan: { type: "string", defaultValue: "free", input: false },
              stripeCustomerId: { type: "string", required: false, input: false },
              stripeSubscriptionId: { type: "string", required: false, input: false },
            },
          },
        },
      }),
    ],
  });
}

export function getAuth() {
  if (!_auth) {
    _auth = createAuth();
  }
  return _auth;
}

/** @deprecated Use getAuth() for lazy initialisation. */
export const auth = new Proxy({} as ReturnType<typeof betterAuth>, {
  get(_target, prop, receiver) {
    return Reflect.get(getAuth(), prop, receiver);
  },
});

export type Session = ReturnType<typeof betterAuth>["$Infer"]["Session"];
