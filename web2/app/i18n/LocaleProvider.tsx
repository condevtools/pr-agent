'use client'

import {
  createContext,
  startTransition,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

export type Locale = 'en' | 'zh'

type LocaleContextValue = {
  locale: Locale
  setLocale: (locale: Locale) => void
}

const STORAGE_KEY = 'web2-locale'
const DEFAULT_LOCALE: Locale = 'en'
const listeners = new Set<() => void>()

function readStoredLocale(): Locale {
  if (typeof window === 'undefined') {
    return DEFAULT_LOCALE
  }

  return window.localStorage.getItem(STORAGE_KEY) === 'zh' ? 'zh' : 'en'
}

function emitChange() {
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)

  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      listener()
    }
  }

  window.addEventListener('storage', onStorage)

  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleProvider({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore(subscribe, readStoredLocale, () => DEFAULT_LOCALE)

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
  }, [locale])

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale: (nextLocale) => {
        if (typeof window === 'undefined') {
          return
        }

        startTransition(() => {
          window.localStorage.setItem(STORAGE_KEY, nextLocale)
          emitChange()
        })
      },
    }),
    [locale]
  )

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale() {
  const context = useContext(LocaleContext)

  if (!context) {
    throw new Error('useLocale must be used within LocaleProvider')
  }

  return context
}
