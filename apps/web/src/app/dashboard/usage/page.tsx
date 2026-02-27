import { SampleDataBanner } from "@/components/sample-data-banner";

const usageData = [
  { date: "2025-02-20", event: "Auto Review", model: "gpt-4o", tokens: 12450, repo: "acme/frontend" },
  { date: "2025-02-20", event: "/review command", model: "gpt-4o", tokens: 8320, repo: "acme/backend" },
  { date: "2025-02-19", event: "Auto Review", model: "claude-3-5-sonnet", tokens: 15200, repo: "acme/mobile-app" },
  { date: "2025-02-19", event: "/fix command", model: "gpt-4o", tokens: 6100, repo: "acme/frontend" },
  { date: "2025-02-19", event: "/ask command", model: "gpt-4o-mini", tokens: 2300, repo: "acme/docs" },
  { date: "2025-02-18", event: "Auto Review", model: "gpt-4o", tokens: 18900, repo: "acme/backend" },
  { date: "2025-02-18", event: "Security Scan", model: "gpt-4o", tokens: 4200, repo: "acme/backend" },
  { date: "2025-02-18", event: "/improve command", model: "claude-3-5-sonnet", tokens: 9800, repo: "acme/frontend" },
  { date: "2025-02-17", event: "Auto Review", model: "gpt-4o-mini", tokens: 3400, repo: "acme/docs" },
  { date: "2025-02-17", event: "Auto Review", model: "gpt-4o", tokens: 14100, repo: "acme/infra" },
];

const summaryStats = [
  { label: "Tokens This Month", value: "2.4M" },
  { label: "Estimated Cost", value: "$18.42" },
  { label: "Avg Tokens / Review", value: "9,847" },
  { label: "Reviews This Month", value: "244" },
];

export default function UsagePage() {
  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Usage</h1>
        <p className="mt-1 text-gray-400">Monitor your AI token consumption and API usage.</p>
      </div>

      <SampleDataBanner />

      {/* Summary Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {summaryStats.map((stat) => (
          <div key={stat.label} className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <p className="text-sm text-gray-400">{stat.label}</p>
            <p className="mt-1 text-2xl font-bold">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Chart Placeholder */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-6">
        <h2 className="text-sm font-medium text-gray-300 mb-4">Daily Token Usage</h2>
        <div className="flex items-end gap-2 h-48">
          {[65, 40, 80, 55, 70, 90, 45, 60, 75, 85, 50, 95, 70, 55].map((height, i) => (
            <div key={i} className="flex-1 flex flex-col items-center gap-1">
              <div
                className="w-full rounded-t-sm bg-indigo-500/60 hover:bg-indigo-500/80 transition-colors"
                style={{ height: `${height}%` }}
              />
            </div>
          ))}
        </div>
        <div className="mt-2 flex justify-between text-xs text-gray-500">
          <span>Feb 14</span>
          <span>Feb 20</span>
          <span>Feb 27</span>
        </div>
      </div>

      {/* Usage Table */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-800">
          <h2 className="text-sm font-medium text-gray-300">Recent Events</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800 text-left text-xs text-gray-500 uppercase tracking-wider">
                <th className="px-6 py-3 font-medium">Date</th>
                <th className="px-6 py-3 font-medium">Event Type</th>
                <th className="px-6 py-3 font-medium">Repository</th>
                <th className="px-6 py-3 font-medium">Model</th>
                <th className="px-6 py-3 font-medium text-right">Tokens</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {usageData.map((row, i) => (
                <tr key={i} className="hover:bg-gray-800/30 transition-colors">
                  <td className="px-6 py-3 text-sm text-gray-400">{row.date}</td>
                  <td className="px-6 py-3 text-sm text-gray-200">{row.event}</td>
                  <td className="px-6 py-3 text-sm text-gray-400">{row.repo}</td>
                  <td className="px-6 py-3">
                    <span className="inline-flex items-center rounded-md bg-gray-800 px-2 py-0.5 text-xs font-medium text-gray-300">
                      {row.model}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-sm text-gray-200 text-right font-mono">
                    {row.tokens.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
