"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

type HeaderProps = {
  userName?: string | null;
  userEmail?: string | null;
};

function getInitial(name?: string | null, email?: string | null): string {
  const fromName = name?.trim().charAt(0);
  if (fromName) return fromName.toUpperCase();
  const fromEmail = email?.trim().charAt(0);
  return fromEmail ? fromEmail.toUpperCase() : "U";
}

export function Header({ userName, userEmail }: HeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const avatarInitial = getInitial(userName, userEmail);
  const displayName = userName?.trim() || "User";
  const displayEmail = userEmail?.trim() || "user@example.com";

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between border-b border-gray-800 bg-gray-950/80 backdrop-blur-sm px-6 py-3">
      {/* Mobile sidebar toggle */}
      <button
        className="lg:hidden rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
        aria-label="Toggle sidebar"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
        </svg>
      </button>

      {/* Breadcrumb / search area */}
      <div className="hidden lg:flex items-center gap-3 text-sm text-gray-400">
        <span>Dashboard</span>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-4">
        {/* Notifications */}
        <button className="relative rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
          </svg>
          <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-indigo-500" />
        </button>

        {/* User menu */}
        <div className="relative">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="flex items-center gap-3 rounded-lg px-3 py-1.5 hover:bg-gray-800 transition-colors"
          >
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-sm font-bold">
              {avatarInitial}
            </div>
            <div className="hidden sm:block text-left">
              <p className="text-sm font-medium text-gray-200">{displayName}</p>
              <p className="text-xs text-gray-500">{displayEmail}</p>
            </div>
            <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
            </svg>
          </button>

          {menuOpen && (
            <div className="absolute right-0 mt-2 w-48 rounded-xl border border-gray-800 bg-gray-900 py-1 shadow-xl">
              <a href="/dashboard/settings" className="block px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 hover:text-gray-100">
                Settings
              </a>
              <hr className="my-1 border-gray-800" />
              <button
                onClick={() => {
                  authClient.signOut({ fetchOptions: { onSuccess: () => { window.location.href = "/"; } } });
                }}
                className="block w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-gray-800"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
