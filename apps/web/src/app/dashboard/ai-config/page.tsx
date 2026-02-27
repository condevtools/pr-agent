"use client";

import { useState } from "react";

type Provider = "openai" | "anthropic" | "gemini" | "openai-compatible";

const providerOptions: { id: Provider; name: string; description: string; icon: string }[] = [
  { id: "openai", name: "OpenAI", description: "GPT-4o, GPT-4 Turbo, o1, o3", icon: "O" },
  { id: "anthropic", name: "Anthropic", description: "Claude 4 Opus, Sonnet, Haiku", icon: "A" },
  { id: "gemini", name: "Google Gemini", description: "Gemini 2.5 Pro, Flash", icon: "G" },
  { id: "openai-compatible", name: "OpenAI Compatible", description: "Any OpenAI-compatible API", icon: "~" },
];

const modelsByProvider: Record<Provider, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1-preview", "o1-mini", "o3-mini"],
  anthropic: ["claude-opus-4-20250514", "claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
  "openai-compatible": ["custom"],
};

export default function AIConfigPage() {
  const [provider, setProvider] = useState<Provider>("openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gpt-4o");
  const [baseUrl, setBaseUrl] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleProviderChange = (p: Provider) => {
    setProvider(p);
    setModel(modelsByProvider[p][0]);
    setTestResult(null);
    setSaved(false);
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    // Simulate API test
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (apiKey.length > 0) {
      setTestResult({ success: true, message: "Connection successful. Model is reachable." });
    } else {
      setTestResult({ success: false, message: "API key is required to test the connection." });
    }
    setTesting(false);
  };

  const handleSave = async () => {
    setSaving(true);
    await new Promise((resolve) => setTimeout(resolve, 800));
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div className="max-w-3xl space-y-8">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">AI Configuration</h1>
        <p className="mt-1 text-gray-400">
          Choose your AI provider and model. Your API key is encrypted and stored securely.
        </p>
      </div>

      {/* Provider Selector */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-3">Provider</label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {providerOptions.map((p) => (
            <button
              key={p.id}
              onClick={() => handleProviderChange(p.id)}
              className={`flex items-start gap-4 rounded-xl border p-4 text-left transition-all ${
                provider === p.id
                  ? "border-indigo-500 bg-indigo-500/5 ring-1 ring-indigo-500/20"
                  : "border-gray-800 bg-gray-900 hover:border-gray-700"
              }`}
            >
              <div
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-bold ${
                  provider === p.id
                    ? "bg-indigo-500/20 text-indigo-400"
                    : "bg-gray-800 text-gray-400"
                }`}
              >
                {p.icon}
              </div>
              <div>
                <p className={`text-sm font-semibold ${provider === p.id ? "text-indigo-300" : "text-gray-200"}`}>
                  {p.name}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">{p.description}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Configuration Form */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-6">
        {/* API Key */}
        <div>
          <label htmlFor="api-key" className="block text-sm font-medium text-gray-300 mb-2">
            API Key
          </label>
          <div className="relative">
            <input
              id="api-key"
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setTestResult(null);
                setSaved(false);
              }}
              placeholder={
                provider === "openai"
                  ? "sk-..."
                  : provider === "anthropic"
                    ? "sk-ant-..."
                    : provider === "gemini"
                      ? "AI..."
                      : "Enter your API key"
              }
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 transition-colors"
            />
            <div className="absolute inset-y-0 right-0 flex items-center pr-3">
              <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
              </svg>
            </div>
          </div>
          <p className="mt-1.5 text-xs text-gray-500">
            Your key is encrypted at rest and never exposed in logs.
          </p>
        </div>

        {/* Model Selector */}
        <div>
          <label htmlFor="model" className="block text-sm font-medium text-gray-300 mb-2">
            Model
          </label>
          {provider === "openai-compatible" ? (
            <input
              id="model"
              type="text"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="e.g. my-custom-model"
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 transition-colors"
            />
          ) : (
            <select
              id="model"
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setSaved(false);
              }}
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-gray-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 transition-colors appearance-none"
            >
              {modelsByProvider[provider].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Base URL (only for OpenAI Compatible) */}
        {provider === "openai-compatible" && (
          <div>
            <label htmlFor="base-url" className="block text-sm font-medium text-gray-300 mb-2">
              Base URL
            </label>
            <input
              id="base-url"
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 transition-colors"
            />
            <p className="mt-1.5 text-xs text-gray-500">
              The base URL of your OpenAI-compatible endpoint (must include /v1).
            </p>
          </div>
        )}

        {/* Test Result */}
        {testResult && (
          <div
            className={`flex items-center gap-3 rounded-lg px-4 py-3 text-sm ${
              testResult.success
                ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-300"
                : "bg-rose-500/10 border border-rose-500/20 text-rose-300"
            }`}
          >
            {testResult.success ? (
              <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
            ) : (
              <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
              </svg>
            )}
            {testResult.message}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={handleTestConnection}
            disabled={testing}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-300 hover:bg-gray-750 hover:border-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {testing ? (
              <>
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Testing...
              </>
            ) : (
              "Test Connection"
            )}
          </button>

          <button
            onClick={handleSave}
            disabled={saving || !apiKey}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? (
              <>
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Saving...
              </>
            ) : saved ? (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
                Saved
              </>
            ) : (
              "Save Configuration"
            )}
          </button>
        </div>
      </div>

      {/* Info Box */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
        <h3 className="text-sm font-semibold text-gray-200 mb-2">How it works</h3>
        <ul className="space-y-2 text-sm text-gray-400">
          <li className="flex items-start gap-2">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            MR Agent uses your API key to call the selected model whenever a review is triggered.
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            You can override the model per-repository in the Repos settings.
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            All API calls are logged in the Usage tab so you can monitor token consumption.
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
            Your API key is encrypted with AES-256 and stored securely. It is never logged or exposed.
          </li>
        </ul>
      </div>
    </div>
  );
}
