"use client";

import { useState } from "react";
import { SampleDataBanner } from "@/components/sample-data-banner";

const members = [
  { id: 1, name: "Alice Chen", email: "alice@acme.com", role: "Owner", avatar: "A" },
  { id: 2, name: "Bob Smith", email: "bob@acme.com", role: "Admin", avatar: "B" },
  { id: 3, name: "Carol Davis", email: "carol@acme.com", role: "Member", avatar: "C" },
];

export default function SettingsPage() {
  const [tenantName, setTenantName] = useState("Acme Corp");
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div className="max-w-3xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-gray-400">Manage your organization settings and team members.</p>
      </div>

      <SampleDataBanner />

      {/* Organization Name */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-4">
        <h2 className="text-lg font-semibold">Organization</h2>
        <div>
          <label htmlFor="tenant-name" className="block text-sm font-medium text-gray-300 mb-2">
            Organization Name
          </label>
          <input
            id="tenant-name"
            type="text"
            value={tenantName}
            onChange={(e) => {
              setTenantName(e.target.value);
              setSaved(false);
            }}
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 transition-colors"
          />
        </div>
        <button
          onClick={handleSave}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium hover:bg-indigo-500 transition-colors"
        >
          {saved ? (
            <>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
              Saved
            </>
          ) : (
            "Save Changes"
          )}
        </button>
      </div>

      {/* Members */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Team Members</h2>
          <button
            disabled
            title="Coming soon"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm font-medium text-gray-300 opacity-50 cursor-not-allowed"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Invite Member
          </button>
        </div>

        <div className="divide-y divide-gray-800">
          {members.map((member) => (
            <div key={member.id} className="flex items-center justify-between py-4 first:pt-0 last:pb-0">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 text-sm font-bold">
                  {member.avatar}
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-200">{member.name}</p>
                  <p className="text-xs text-gray-500">{member.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    member.role === "Owner"
                      ? "bg-amber-500/10 text-amber-400"
                      : member.role === "Admin"
                        ? "bg-indigo-500/10 text-indigo-400"
                        : "bg-gray-700/50 text-gray-400"
                  }`}
                >
                  {member.role}
                </span>
                {member.role !== "Owner" && (
                  <button className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Danger Zone */}
      <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-rose-400">Danger Zone</h2>
        <p className="text-sm text-gray-400">
          Once you delete your organization, all data including repositories, configurations, and
          review history will be permanently removed. This action cannot be undone.
        </p>
        <button
          disabled
          title="Coming soon"
          className="inline-flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm font-medium text-rose-400 opacity-50 cursor-not-allowed"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
          </svg>
          Delete Organization
        </button>
      </div>
    </div>
  );
}
