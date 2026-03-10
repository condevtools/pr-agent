'use client'

import { useEffect, useRef, useState } from 'react'

export default function CustomCursor() {
  const [enabled, setEnabled] = useState(false)
  const cursorRef = useRef<HTMLDivElement>(null)
  const pos = useRef({ x: 0, y: 0 })
  const target = useRef({ x: 0, y: 0 })
  const rafRef = useRef<number>(0)
  const moving = useRef(false)

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
      if (!moving.current) {
        moving.current = true
        rafRef.current = requestAnimationFrame(loop)
      }
    }

    const loop = () => {
      const ease = 0.12
      const dx = target.current.x - pos.current.x
      const dy = target.current.y - pos.current.y
      pos.current.x += dx * ease
      pos.current.y += dy * ease

      if (cursorRef.current) {
        cursorRef.current.style.transform = `translate(${pos.current.x}px, ${pos.current.y}px)`
      }

      if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) {
        moving.current = false
        return
      }

      rafRef.current = requestAnimationFrame(loop)
    }

    window.addEventListener('mousemove', onMove)

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
