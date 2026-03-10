export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || 'https://pr-agent.condevtools.com'

export const SITE_NAME = 'PR Agent'
export const SITE_TITLE = 'PR Agent | AI Code Review for GitHub App'
export const SITE_DESCRIPTION =
  'PR Agent is an AI-powered code review service focused on GitHub App workflows, with automatic pull request review, policy-aware feedback, and operational endpoints for production rollout.'

export const SEO_KEYWORDS = [
  'PR Agent',
  'AI code review',
  'GitHub App review',
  'pull request review automation',
  'GitHub App code review',
  'code review bot',
  'AI reviewer',
  'PR automation',
  '代码评审',
  'AI 代码评审',
  'GitHub App',
]

export const GITHUB_REPO_URL = 'https://github.com/condevtools/pr-agent'
export const INSTALL_URL = 'https://github.com/apps/condev-code-agent'

export function buildJsonLdGraph() {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      name: SITE_NAME,
      url: SITE_URL,
      inLanguage: ['en', 'zh-CN'],
      description: SITE_DESCRIPTION,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: SITE_NAME,
      url: SITE_URL,
      sameAs: [GITHUB_REPO_URL, INSTALL_URL],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      '@id': `${SITE_URL}/#software`,
      name: SITE_NAME,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Web',
      url: SITE_URL,
      codeRepository: GITHUB_REPO_URL,
      installUrl: INSTALL_URL,
      description: SITE_DESCRIPTION,
      publisher: {
        '@id': `${SITE_URL}/#organization`,
      },
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
      },
    },
  ]
}

export function buildLlmsTxt() {
  return [
    '# PR Agent',
    '',
    `Canonical: ${SITE_URL}`,
    '',
    'Summary:',
    'PR Agent is an AI-powered code review service focused on GitHub App workflows.',
    '',
    'Primary links:',
    `- Website: ${SITE_URL}`,
    `- GitHub: ${GITHUB_REPO_URL}`,
    `- Install: ${INSTALL_URL}`,
    '',
    'Key capabilities:',
    '- Automatic pull request review for GitHub App workflows',
    '- Policy-aware feedback and repository process checks',
    '- Comment-driven review commands',
    '- Health, metrics, and replay-friendly operational endpoints',
  ].join('\n')
}
