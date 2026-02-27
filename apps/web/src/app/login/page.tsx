"use client";

import Link from "next/link";
import { authClient } from "@/lib/auth-client";

export default function LoginPage() {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[var(--color-page-bg)] px-6 py-16">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,#ffffff08_1px,transparent_1px),linear-gradient(to_bottom,#ffffff08_1px,transparent_1px)] bg-[size:44px_44px] opacity-20" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,#10b9811a,transparent_55%)]" />

      <div className="relative w-full max-w-md border border-[var(--color-terminal-border)] bg-[var(--color-terminal-bg)]">
        <div className="flex items-center justify-between border-b border-[var(--color-terminal-border)] px-5 py-3">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="font-jetbrains text-[20px] font-bold text-[var(--color-emerald)]">
              {">"}_
            </span>
            <span className="font-jetbrains text-[15px] font-medium text-[#FAFAFA]">
              mr-agent
            </span>
          </Link>
          <span className="font-jetbrains text-[11px] text-[var(--color-gray-dim)]">
            auth/login
          </span>
        </div>

        <div className="flex flex-col gap-6 p-8">
          <div className="flex flex-col gap-2 text-center">
            <h1 className="font-jetbrains text-[28px] font-bold text-[#FAFAFA]">
              sign in to continue
            </h1>
            <p className="font-ibm-plex text-[13px] leading-[1.6] text-[var(--color-gray-muted)]">
              connect github and manage ai code reviews with the same workflow as the landing page.
            </p>
          </div>

          <button
            onClick={() => {
              authClient.signIn.social({ provider: "github" });
            }}
            className="flex w-full items-center justify-center gap-3 bg-[var(--color-emerald)] px-4 py-3.5 transition-opacity hover:opacity-90"
          >
            <svg className="h-5 w-5 text-[#0A0A0A]" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            <span className="font-jetbrains text-[13px] font-medium text-[#0A0A0A]">
              $ sign_in_with_github
            </span>
          </button>

          <div className="border border-[var(--color-terminal-border)] p-4">
            <p className="font-ibm-plex text-center text-[12px] leading-[1.6] text-[var(--color-gray-muted)]">
              By signing in, you agree to our{" "}
              <a href="#" className="text-[var(--color-emerald)] hover:opacity-80">
                Terms of Service
              </a>{" "}
              and{" "}
              <a href="#" className="text-[var(--color-emerald)] hover:opacity-80">
                Privacy Policy
              </a>
              .
            </p>
          </div>

          <Link
            href="/"
            className="inline-flex items-center justify-center border border-[var(--color-terminal-border)] px-4 py-2 font-jetbrains text-[12px] text-[var(--color-gray-muted)] transition-colors hover:border-[var(--color-emerald)] hover:text-[#FAFAFA]"
          >
            {"<"} back_to_landing
          </Link>
        </div>
      </div>
    </div>
  );
}
