FROM node:22-alpine AS build

WORKDIR /app

RUN npm install -g pnpm@10.10.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY backend/package.json ./backend/

RUN pnpm install --filter backend --frozen-lockfile

COPY backend/tsconfig.json ./backend/
COPY backend/src ./backend/src
COPY backend/scripts/copy-agent-runtime-assets.mjs ./backend/scripts/copy-agent-runtime-assets.mjs
COPY backend/scripts/build.mjs ./backend/scripts/build.mjs
COPY backend/scripts/fix-sandbox-runner.mjs ./backend/scripts/fix-sandbox-runner.mjs

RUN pnpm --filter backend build

FROM node:22-alpine AS production-dependencies

WORKDIR /app

RUN npm install -g pnpm@10.10.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY backend/package.json ./backend/

RUN pnpm install --filter backend --prod --frozen-lockfile

FROM node:22-alpine AS verifier-sandbox

RUN addgroup -g 65532 verifier \
    && adduser -D -H -u 65532 -G verifier verifier \
    && mkdir -p /opt/pr-agent-verifier /seed \
    && chown -R 65532:65532 /opt/pr-agent-verifier /seed

COPY --chown=65532:65532 backend/scripts/fix-sandbox-runner.mjs /opt/pr-agent-verifier/fix-sandbox-runner.mjs
COPY --chown=65532:65532 --from=build /app/backend/dist/repository/diff/unified-patch.js /opt/pr-agent-verifier/unified-patch.js

USER 65532:65532

FROM node:22-alpine AS runtime

WORKDIR /app/backend

ENV NODE_ENV=production \
    PR_AGENT_HEALTH_DIRECTORY=/tmp/pr-agent/health

RUN addgroup -S -g 10001 pr-agent \
    && adduser -S -D -H -u 10001 -G pr-agent pr-agent

COPY --from=production-dependencies /app/node_modules /app/node_modules
COPY --from=production-dependencies /app/backend/node_modules ./node_modules
COPY --chown=10001:10001 backend/package.json ./
COPY --chown=10001:10001 --from=build /app/backend/dist ./dist

USER 10001:10001

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "dist/agent-runtime/health-cli.js"]

EXPOSE 3000

CMD ["node", "dist/main.js"]

FROM runtime AS verifier

USER root
RUN apk add --no-cache docker-cli
USER 10001:10001

ENV PR_AGENT_PROCESS_ROLE=verifier

CMD ["node", "dist/fix/verification/cli.js"]

# Preserve the historical default image as the web/runtime image.
FROM runtime AS default
