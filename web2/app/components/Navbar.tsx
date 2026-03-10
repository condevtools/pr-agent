'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

const NAV_LINKS = ['About', 'Services', 'Portfolio', 'Pricing', 'Blog']

export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled ? 'bg-black/90 backdrop-blur-md border-b border-white/10' : 'bg-transparent'
      }`}
    >
      <div className="max-w-[1440px] mx-auto px-6 lg:px-10 h-16 flex items-center justify-between">
        <Link href="/" className="text-xl font-bold text-white tracking-tight">
          Landin
        </Link>

        <div className="hidden md:flex items-center gap-8">
          {NAV_LINKS.map((link) => (
            <Link
              key={link}
              href={`/${link.toLowerCase()}`}
              className="text-sm text-white/60 hover:text-white transition-colors"
            >
              {link}
            </Link>
          ))}
        </div>

        <div className="hidden md:block">
          <Link
            href="/contact"
            className="px-5 py-2.5 bg-[#0055fe] text-white text-sm font-medium hover:bg-[#0044cc] transition-colors"
          >
            Connect With Us
          </Link>
        </div>

        <button
          className="md:hidden text-white p-2"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label="Toggle menu"
        >
          {mobileOpen ? (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          )}
        </button>
      </div>

      {mobileOpen && (
        <div className="md:hidden bg-[#080808] border-t border-white/10 px-6 py-4 flex flex-col gap-2">
          {NAV_LINKS.map((link) => (
            <Link
              key={link}
              href={`/${link.toLowerCase()}`}
              className="text-white/70 hover:text-white transition-colors py-2 border-b border-white/5"
              onClick={() => setMobileOpen(false)}
            >
              {link}
            </Link>
          ))}
          <Link
            href="/contact"
            className="mt-3 px-5 py-3 bg-[#0055fe] text-white text-sm font-medium text-center"
            onClick={() => setMobileOpen(false)}
          >
            Connect With Us
          </Link>
        </div>
      )}
    </nav>
  )
}
