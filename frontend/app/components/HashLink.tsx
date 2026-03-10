'use client'

import type { AnchorHTMLAttributes, MouseEvent } from 'react'

const NAVBAR_OFFSET = 88

function scrollToHash(hash: string) {
  if (typeof window === 'undefined') {
    return
  }

  const id = hash.startsWith('#') ? decodeURIComponent(hash.slice(1)) : decodeURIComponent(hash)
  const element = document.getElementById(id)

  if (!element) {
    window.location.hash = hash
    return
  }

  const top = Math.max(0, element.getBoundingClientRect().top + window.scrollY - NAVBAR_OFFSET)

  window.history.replaceState(null, '', `#${id}`)
  window.scrollTo({ top, behavior: 'smooth' })
}

type HashLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: `#${string}`
  onNavigate?: () => void
}

export default function HashLink({
  href,
  onClick,
  onNavigate,
  children,
  ...props
}: HashLinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) {
      return
    }

    event.preventDefault()
    onNavigate?.()

    window.requestAnimationFrame(() => {
      scrollToHash(href)
    })
  }

  return (
    <a {...props} href={href} onClick={handleClick}>
      {children}
    </a>
  )
}
