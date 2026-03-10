'use client'

import type { ReactNode } from 'react'
import { useRef } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'

gsap.registerPlugin(useGSAP, ScrollTrigger)

export default function HomeMotionMain({ children }: { children: ReactNode }) {
  const scope = useRef<HTMLElement>(null)

  useGSAP(
    () => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return
      }

      const heroItems = gsap.utils.toArray<HTMLElement>('[data-gsap="hero"]')
      if (heroItems.length > 0) {
        gsap.fromTo(
          heroItems,
          { opacity: 0, y: 32, filter: 'blur(12px)' },
          {
            opacity: 1,
            y: 0,
            filter: 'blur(0px)',
            duration: 0.9,
            stagger: 0.12,
            ease: 'power3.out',
          }
        )
      }

      gsap.utils.toArray<HTMLElement>('[data-gsap="reveal"]').forEach((element) => {
        gsap.fromTo(
          element,
          { opacity: 0, y: 36, filter: 'blur(10px)' },
          {
            opacity: 1,
            y: 0,
            filter: 'blur(0px)',
            duration: 0.9,
            ease: 'power3.out',
            scrollTrigger: {
              trigger: element,
              start: 'top 84%',
              toggleActions: 'play none none reverse',
            },
          }
        )
      })

      gsap.utils.toArray<HTMLElement>('[data-gsap="cards"]').forEach((group) => {
        const items = Array.from(group.children) as HTMLElement[]
        if (items.length === 0) {
          return
        }

        gsap.fromTo(
          items,
          { opacity: 0, y: 42 },
          {
            opacity: 1,
            y: 0,
            duration: 0.8,
            stagger: 0.12,
            ease: 'power3.out',
            scrollTrigger: {
              trigger: group,
              start: 'top 78%',
              toggleActions: 'play none none reverse',
            },
          }
        )
      })

      ScrollTrigger.refresh()
    },
    { scope }
  )

  return (
    <main ref={scope} className="bg-black min-h-screen">
      {children}
    </main>
  )
}
