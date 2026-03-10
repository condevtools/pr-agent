import type { Metadata } from 'next'
import './globals.css'
import CustomCursor from './components/CustomCursor'
import { LocaleProvider } from './i18n/LocaleProvider'

export const metadata: Metadata = {
  title: 'PR Agent | AI-powered Code Review | AI 代码评审服务',
  description:
    'AI-powered code review service for GitHub and GitLab pull/merge workflows. 面向 GitHub 与 GitLab PR/MR 流程的 AI 代码评审服务。',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <LocaleProvider>
          <CustomCursor />
          {children}
        </LocaleProvider>
      </body>
    </html>
  )
}
