"use client";

import { useState, useCallback } from "react";
import { Sidebar } from "@/components/sidebar";
import { Header } from "@/components/header";

type DashboardShellProps = {
  userName?: string | null;
  userEmail?: string | null;
  currentPlan?: string;
  children: React.ReactNode;
};

export function DashboardShell({ userName, userEmail, currentPlan, children }: DashboardShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const toggleSidebar = useCallback(() => setSidebarOpen((o) => !o), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar — always visible on lg+ */}
      <div className="hidden lg:flex">
        <Sidebar currentPlan={currentPlan} />
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/60"
            onClick={closeSidebar}
            aria-hidden="true"
          />
          {/* Sidebar panel */}
          <div className="relative z-50 flex h-full w-64">
            <Sidebar currentPlan={currentPlan} onNavigate={closeSidebar} />
          </div>
        </div>
      )}

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header
          userName={userName}
          userEmail={userEmail}
          onToggleSidebar={toggleSidebar}
        />
        <main className="flex-1 overflow-y-auto p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
