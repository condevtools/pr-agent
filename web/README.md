# MR Agent Web

Marketing/presentation frontend for MR Agent, built with Next.js App Router + `next-intl`.

## Stack

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS v4
- `next-intl` (zh/en routing and messages)

## Local Development

```bash
cd web
npm install
npm run dev
```

Default local URL: `http://localhost:3000`

## Build and Run

```bash
cd web
npm run build
npm run start
```

## Quality Checks

```bash
cd web
npm run lint
# run web tests from repository root (uses root dev dependency `tsx`)
cd ..
node --import tsx --test web/tests/*.test.ts
```

## Project Structure

- `app/` - App Router pages, layouts, SEO routes (`sitemap.ts`, `robots.ts`, `llms.txt`)
- `components/home/` - homepage sections and interactive components
- `i18n/` + `messages/` - locale config and translation content
- `lib/` - SEO and i18n helpers
- `tests/` - Node test files for i18n and SEO config
