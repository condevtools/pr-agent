'use client'

import { startTransition, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import HashLink from './HashLink'
import { useLocale } from '../i18n/LocaleProvider'

const UnicornHeroBg = dynamic(() => import('./UnicornHeroBg'), {
  ssr: false,
  loading: () => null,
})

type HeroBackgroundMode = 'static' | 'interactive'

const MOBILE_MEDIA_QUERY = '(max-width: 767px)'
const REDUCED_MOTION_MEDIA_QUERY = '(prefers-reduced-motion: reduce)'

function getHeroBackgroundMode(): HeroBackgroundMode {
  const isMobile = globalThis.matchMedia(MOBILE_MEDIA_QUERY).matches
  const prefersReducedMotion = globalThis.matchMedia(
    REDUCED_MOTION_MEDIA_QUERY
  ).matches

  return isMobile || prefersReducedMotion ? 'static' : 'interactive'
}

const COPY = {
  en: {
    badge: 'GitHub App · TypeScript + NestJS',
    title: 'AI code review',
    subtitle: 'for GitHub App',
    body:
      'PR Agent focuses on GitHub App workflows: automatic pull request review, structured summaries, policy-aware feedback, and operational endpoints for real-world rollout.',
    primaryCta: 'View Capabilities',
    secondaryCta: 'Read Deployment Baseline',
    socialProof: 'GitHub App only · PR review focused',
  },
  zh: {
    badge: 'GitHub App · TypeScript + NestJS',
    title: 'GitHub App 的',
    subtitle: 'AI 代码评审服务',
    body:
      'PR Agent 当前聚焦 GitHub App 工作流，提供 Pull Request 自动评审、结构化总结、策略感知反馈，以及适合真实接入的运维端点。',
    primaryCta: '查看能力',
    secondaryCta: '阅读部署基线',
    socialProof: '仅 GitHub App · 聚焦 PR 评审',
  },
} as const

export default function HeroSection() {
  const { locale } = useLocale()
  const copy = COPY[locale]
  const [backgroundMode, setBackgroundMode] = useState<HeroBackgroundMode>('static')
  const [showUnicornBg, setShowUnicornBg] = useState(false)

  useEffect(() => {
    const updateMode = () => {
      setBackgroundMode(getHeroBackgroundMode())
    }

    updateMode()

    const mobileMediaQuery = globalThis.matchMedia(MOBILE_MEDIA_QUERY)
    const reducedMotionMediaQuery = globalThis.matchMedia(
      REDUCED_MOTION_MEDIA_QUERY
    )

    mobileMediaQuery.addEventListener?.('change', updateMode)
    reducedMotionMediaQuery.addEventListener?.('change', updateMode)

    return () => {
      mobileMediaQuery.removeEventListener?.('change', updateMode)
      reducedMotionMediaQuery.removeEventListener?.('change', updateMode)
    }
  }, [])

  useEffect(() => {
    if (backgroundMode === 'static' || showUnicornBg) {
      return
    }

    const revealBg = () => {
      startTransition(() => {
        setShowUnicornBg(true)
      })
    }

    const requestIdle = globalThis.requestIdleCallback?.bind(globalThis)
    const cancelIdle = globalThis.cancelIdleCallback?.bind(globalThis)

    if (requestIdle && cancelIdle) {
      const idleId = requestIdle(revealBg, { timeout: 1500 })
      return () => cancelIdle(idleId)
    }

    const timeoutId = globalThis.setTimeout(revealBg, 1200)
    return () => globalThis.clearTimeout(timeoutId)
  }, [backgroundMode, showUnicornBg])

  return (
    <section
      id="overview"
      className="relative min-h-screen flex flex-col items-center justify-center pt-20 overflow-hidden bg-black"
    >
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat opacity-90"
          style={{ backgroundImage: "url('/hero.webp')" }}
        />
        {backgroundMode !== 'static' && showUnicornBg ? <UnicornHeroBg /> : null}
      </div>

      <div className="relative z-10 max-w-[1440px] mx-auto px-5 sm:px-6 lg:px-10 text-center w-full">
        <div
          data-gsap="hero"
          className="inline-flex max-w-full items-center gap-2.5 px-4 py-2 border border-white/15 rounded-full mb-8"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-white" />
          <span className="text-white/70 text-sm">{copy.badge}</span>
        </div>

        <h1
          data-gsap="hero"
          className="text-4xl sm:text-5xl md:text-6xl lg:text-[84px] font-bold text-white leading-[1.05] tracking-tight mb-6 max-w-5xl mx-auto"
        >
          {copy.title}
          <br />
          {copy.subtitle}
        </h1>

        <p
          data-gsap="hero"
          className="text-white/55 text-base sm:text-lg max-w-[620px] mx-auto mb-10 leading-relaxed"
        >
          {copy.body}
        </p>

        <div data-gsap="hero" className="flex flex-wrap items-center justify-center gap-4 mb-16 max-w-md sm:max-w-none mx-auto">
          <HashLink
            href="#features"
            className="w-full sm:w-auto justify-center inline-flex px-8 py-4 bg-[#0055fe] text-white font-medium text-sm hover:bg-[#0044cc] transition-colors"
          >
            {copy.primaryCta}
          </HashLink>
          <HashLink
            href="#deployment"
            className="w-full sm:w-auto justify-center inline-flex px-8 py-4 border border-white/25 text-white/80 text-sm hover:border-white/50 hover:text-white transition-colors"
          >
            {copy.secondaryCta}
          </HashLink>
        </div>

        <div
          data-gsap="hero"
          className="inline-flex max-w-full flex-wrap items-center justify-center gap-3 px-5 py-2.5 bg-white/5 border border-white/10 rounded-2xl"
        >
          <div className="flex -space-x-2">
            {[...Array(5)].map((_, i) => (
              <div
                key={i}
                className="w-7 h-7 rounded-full border-2 border-black bg-gradient-to-br from-white/40 to-white/20"
                style={{ zIndex: 5 - i }}
              />
            ))}
          </div>
          <span className="text-white/60 text-sm">{copy.socialProof}</span>
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-black to-transparent pointer-events-none" />
    </section>
  )
}
