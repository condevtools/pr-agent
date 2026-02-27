import { SampleDataBanner } from "@/components/sample-data-banner";

const stats = [
  { label: "Total Reviews", value: "1,284", change: "+12%", changeType: "positive" as const },
  { label: "Active Repos", value: "23", change: "+3", changeType: "positive" as const },
  { label: "Commands Used", value: "4,891", change: "+8%", changeType: "positive" as const },
  { label: "Tokens Used", value: "2.4M", change: "-5%", changeType: "negative" as const },
];

const recentActivity = [
  {
    id: 1,
    type: "review",
    repo: "acme/frontend",
    description: "Auto-reviewed PR #342: Add user authentication flow",
    time: "2 minutes ago",
  },
  {
    id: 2,
    type: "command",
    repo: "acme/backend",
    description: "/fix applied to PR #128: Fix N+1 query in users endpoint",
    time: "15 minutes ago",
  },
  {
    id: 3,
    type: "review",
    repo: "acme/mobile-app",
    description: "Auto-reviewed PR #89: Update dependencies and fix deprecations",
    time: "1 hour ago",
  },
  {
    id: 4,
    type: "security",
    repo: "acme/backend",
    description: "Security scan flagged hardcoded secret in PR #127",
    time: "2 hours ago",
  },
  {
    id: 5,
    type: "command",
    repo: "acme/docs",
    description: "/ask answered question about API rate limiting in PR #56",
    time: "3 hours ago",
  },
];

function getActivityIcon(type: string) {
  switch (type) {
    case "review":
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-400">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
          </svg>
        </div>
      );
    case "command":
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" />
          </svg>
        </div>
      );
    case "security":
      return (
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-rose-500/10 text-rose-400">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
        </div>
      );
    default:
      return null;
  }
}

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      {/* Welcome */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Welcome back</h1>
        <p className="mt-1 text-gray-400">Here is what is happening with your repositories today.</p>
      </div>

      <SampleDataBanner />

      {/* Stats Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-xl border border-gray-800 bg-gray-900 p-6"
          >
            <p className="text-sm text-gray-400">{stat.label}</p>
            <div className="mt-2 flex items-baseline gap-2">
              <p className="text-3xl font-bold">{stat.value}</p>
              <span
                className={`text-sm font-medium ${
                  stat.changeType === "positive" ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                {stat.change}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Recent Activity */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Recent Activity</h2>
        <div className="rounded-xl border border-gray-800 bg-gray-900 divide-y divide-gray-800">
          {recentActivity.map((activity) => (
            <div key={activity.id} className="flex items-start gap-4 p-4">
              {getActivityIcon(activity.type)}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-200">{activity.description}</p>
                <p className="mt-1 text-xs text-gray-500">{activity.repo}</p>
              </div>
              <span className="shrink-0 text-xs text-gray-500">{activity.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
