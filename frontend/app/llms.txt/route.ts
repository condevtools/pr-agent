import { buildLlmsTxt } from '../../lib/seo-geo'

export const dynamic = 'force-static'

export function GET(): Response {
  return new Response(buildLlmsTxt(), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  })
}
