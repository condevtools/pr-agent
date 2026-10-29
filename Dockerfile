FROM node:22-alpine AS build

WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY backend/package.json ./backend/

RUN pnpm install --filter backend --frozen-lockfile

COPY backend/tsconfig.json ./backend/
COPY backend/src ./backend/src
COPY backend/scripts/copy-agent-runtime-assets.mjs ./backend/scripts/copy-agent-runtime-assets.mjs
COPY backend/scripts/build.mjs ./backend/scripts/build.mjs
COPY backend/scripts/fix-sandbox-runner.mjs ./backend/scripts/fix-sandbox-runner.mjs

RUN pnpm --filter backend build

FROM node:22-alpine AS verifier-sandbox

RUN addgroup -g 65532 verifier \
    && adduser -D -H -u 65532 -G verifier verifier

COPY backend/scripts/fix-sandbox-runner.mjs /opt/pr-agent-verifier/fix-sandbox-runner.mjs
COPY --from=build /app/backend/dist/repository/diff/unified-patch.js /opt/pr-agent-verifier/unified-patch.js

FROM node:22-alpine AS runtime

WORKDIR /app/backend

ENV NODE_ENV=production

RUN npm install -g pnpm

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml /app/
COPY backend/package.json ./

RUN pnpm install --filter backend --prod --frozen-lockfile

COPY --from=build /app/backend/dist ./dist

EXPOSE 3000

CMD ["node", "dist/main.js"]

FROM runtime AS verifier

RUN apk add --no-cache docker-cli

CMD ["node", "dist/fix/verification/cli.js"]

# Preserve the historical default image as the web/runtime image.
FROM runtime AS default
