const repositories = [
  {
    id: 1,
    name: "acme/frontend",
    language: "TypeScript",
    status: "active" as const,
    lastReview: "2 minutes ago",
    totalReviews: 342,
    openPRs: 5,
  },
  {
    id: 2,
    name: "acme/backend",
    language: "Go",
    status: "active" as const,
    lastReview: "15 minutes ago",
    totalReviews: 128,
    openPRs: 3,
  },
  {
    id: 3,
    name: "acme/mobile-app",
    language: "Swift",
    status: "active" as const,
    lastReview: "1 hour ago",
    totalReviews: 89,
    openPRs: 2,
  },
  {
    id: 4,
    name: "acme/data-pipeline",
    language: "Python",
    status: "paused" as const,
    lastReview: "3 days ago",
    totalReviews: 45,
    openPRs: 0,
  },
  {
    id: 5,
    name: "acme/docs",
    language: "Markdown",
    status: "active" as const,
    lastReview: "3 hours ago",
    totalReviews: 56,
    openPRs: 1,
  },
  {
    id: 6,
    name: "acme/infra",
    language: "HCL",
    status: "paused" as const,
    lastReview: "1 week ago",
    totalReviews: 22,
    openPRs: 0,
  },
];

function getLanguageColor(language: string): string {
  const colors: Record<string, string> = {
    TypeScript: "bg-blue-400",
    Go: "bg-cyan-400",
    Swift: "bg-orange-400",
    Python: "bg-yellow-400",
    Markdown: "bg-gray-400",
    HCL: "bg-purple-400",
  };
  return colors[language] || "bg-gray-400";
}

export default function ReposPage() {
  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Repositories</h1>
          <p className="mt-1 text-gray-400">Manage which repos MR Agent monitors and reviews.</p>
        </div>
        <button className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium hover:bg-indigo-500 transition-colors">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add Repository
        </button>
      </div>

      {/* Repository List */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 divide-y divide-gray-800">
        {repositories.map((repo) => (
          <div key={repo.id} className="flex items-center justify-between p-5 hover:bg-gray-800/30 transition-colors">
            <div className="flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-800 text-gray-400">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" />
                </svg>
              </div>
              <div>
                <div className="flex items-center gap-3">
                  <p className="text-sm font-semibold text-gray-200">{repo.name}</p>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      repo.status === "active"
                        ? "bg-emerald-500/10 text-emerald-400"
                        : "bg-gray-700/50 text-gray-400"
                    }`}
                  >
                    {repo.status}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-4 text-xs text-gray-500">
                  <span className="flex items-center gap-1.5">
                    <span className={`h-2 w-2 rounded-full ${getLanguageColor(repo.language)}`} />
                    {repo.language}
                  </span>
                  <span>{repo.totalReviews} reviews</span>
                  <span>{repo.openPRs} open PRs</span>
                  <span>Last review: {repo.lastReview}</span>
                </div>
              </div>
            </div>
            <button className="rounded-lg p-2 text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
