'use client'

import HashLink from './HashLink'
import { useLocale } from '../i18n/LocaleProvider'

const COPY = {
  en: {
    label: 'Overview',
    title: 'Not just a summary generator.',
    subtitle: 'Built for real PR/MR review workflows.',
    cardBody:
      'Turn webhook intake into review output that actually fits engineering flow.',
    cardCta: 'See Workflow',
    body:
      'PR Agent is built with TypeScript + NestJS and designed around real GitHub and GitLab collaboration paths. It supports automatic review as well as comment commands for Q&A, checks, test drafting, and documentation help.',
    bullets: [
      'Supports GitHub App, GitHub Webhook, and GitLab Webhook modes.',
      'Supports comment/report modes with line-aware diff mapping.',
      'Uses .mr-agent.yml for policy reminders, command switches, and review guardrails.',
    ],
    cta: 'View Capabilities',
  },
  zh: {
    label: '项目概览',
    title: '不只是生成一段总结。',
    subtitle: '而是完整接住 PR/MR 评审流程。',
    cardBody: '把 webhook 输入真正转换成符合研发流程的评审输出。',
    cardCta: '查看流程',
    body:
      'PR Agent 基于 TypeScript + NestJS 构建，围绕 GitHub 与 GitLab 的真实协作链路设计，同时覆盖自动评审与评论命令。',
    bullets: [
      '支持 GitHub App、GitHub Webhook 与 GitLab Webhook 三种接入方式。',
      '支持 comment / report 模式，并按行映射 diff 输出反馈。',
      '通过 .mr-agent.yml 管理策略提醒、命令开关与评审护栏。',
    ],
    cta: '查看能力',
  },
} as const

export default function AboutSection() {
  const { locale } = useLocale()
  const copy = COPY[locale]

  return (
    <section id="about" className="bg-black py-20 md:py-24 lg:py-32">
      <div className="max-w-[1440px] mx-auto px-5 sm:px-6 lg:px-10">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          <div className="relative">
            <div className="relative bg-[#080808] border border-white/8 aspect-[528/534] max-w-[528px] mx-auto lg:mx-0 flex flex-col justify-between p-6 sm:p-8 lg:p-10">
              <div className="absolute inset-[10px] border border-white/5" />

              <div className="relative z-10">
                <div className="w-12 h-12 rounded-full bg-[#0055fe]/20 flex items-center justify-center mb-6">
                  <div className="w-5 h-5 rounded-full bg-[#0055fe]" />
                </div>
                <p className="text-white/40 text-sm leading-relaxed max-w-[320px]">
                  {copy.cardBody}
                </p>
              </div>

              <div className="relative z-10">
                <HashLink
                  href="#process"
                  className="inline-flex items-center gap-3 px-6 py-3 bg-[#0055fe] text-white text-sm font-medium hover:bg-[#0044cc] transition-colors"
                >
                  {copy.cardCta}
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                </HashLink>
              </div>

              <div className="absolute bottom-0 left-10 right-10 h-px bg-white/5" />
            </div>
          </div>

          <div className="flex flex-col gap-6">
            <div data-gsap="reveal" className="inline-flex items-center gap-2 w-fit">
              <span className="w-1.5 h-1.5 rounded-full bg-white/60" />
              <span className="text-white/50 text-sm">{copy.label}</span>
            </div>

            <div data-gsap="reveal">
              <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white leading-tight mb-1">
                {copy.title}
              </h2>
              <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white leading-tight">
                {copy.subtitle}
              </h2>
            </div>

            <p data-gsap="reveal" className="text-white/55 text-base leading-relaxed max-w-[560px]">{copy.body}</p>

            <div data-gsap="cards" className="flex flex-col gap-3 mt-2">
              {copy.bullets.map((stat) => (
                <div key={stat} className="flex items-center gap-3">
                  <div className="flex-shrink-0 w-5 h-5 rounded-full bg-[#0055fe]/20 flex items-center justify-center">
                    <svg className="w-3 h-3 text-[#0055fe]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <span className="text-white/80 text-sm">{stat}</span>
                </div>
              ))}
            </div>

            <div className="mt-4">
              <HashLink
                href="#features"
                data-gsap="reveal"
                className="inline-flex w-full sm:w-fit justify-center items-center gap-3 px-6 py-3 bg-[#0055fe] text-white text-sm font-medium hover:bg-[#0044cc] transition-colors"
              >
                {copy.cta}
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </HashLink>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
