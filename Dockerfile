FROM node:22-alpine AS build

WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY backend/package.json ./backend/

RUN pnpm install --filter backend --frozen-lockfile

COPY backend/tsconfig.json ./backend/
COPY backend/src ./backend/src

RUN pnpm --filter backend build

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
