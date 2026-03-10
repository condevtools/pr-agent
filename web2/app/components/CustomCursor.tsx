'use client'

import { useEffect, useRef, useState } from 'react'

export default function CustomCursor() {
  const [enabled, setEnabled] = useState(false)
  const cursorRef = useRef<HTMLDivElement>(null)
  const pos = useRef({ x: 0, y: 0 })
  const target = useRef({ x: 0, y: 0 })
  const rafRef = useRef<number>(0)

  useEffect(() => {
    const mediaQuery = window.matchMedia('(hover: hover) and (pointer: fine)')
    const updateEnabled = () => setEnabled(mediaQuery.matches)
    updateEnabled()
    mediaQuery.addEventListener('change', updateEnabled)

    return () => {
      mediaQuery.removeEventListener('change', updateEnabled)
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      return
    }

    const onMove = (e: MouseEvent) => {
      target.current = { x: e.clientX, y: e.clientY }
    }

    const loop = () => {
      const ease = 0.12
      pos.current.x += (target.current.x - pos.current.x) * ease
      pos.current.y += (target.current.y - pos.current.y) * ease

      if (cursorRef.current) {
        cursorRef.current.style.transform = `translate(${pos.current.x}px, ${pos.current.y}px)`
      }

      rafRef.current = requestAnimationFrame(loop)
    }

    window.addEventListener('mousemove', onMove)
    rafRef.current = requestAnimationFrame(loop)

    return () => {
      window.removeEventListener('mousemove', onMove)
      cancelAnimationFrame(rafRef.current)
    }
  }, [enabled])

  if (!enabled) {
    return null
  }

  return (
    <div
      ref={cursorRef}
      className="fixed top-0 left-0 z-[9999] pointer-events-none"
      style={{ willChange: 'transform' }}
    >
      <div
        className="rounded-full bg-white"
        style={{ width: '12px', height: '12px', transform: 'translate(-50%, -50%)' }}
      />
    </div>
  )
}
