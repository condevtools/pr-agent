import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createDbClient } from "@mr-agent/db";
import { readRequiredEnv, resolveAppUrl } from "./env";

const prisma = createDbClient();

export const auth = betterAuth({
  baseURL: resolveAppUrl(),
  secret: readRequiredEnv("BETTER_AUTH_SECRET", {
    allowPlaceholderInNextBuild: true,
  }),
  database: prismaAdapter(prisma, { provider: "postgresql" }),
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

export type Session = typeof auth.$Infer.Session;
