export interface TenantAIConfig {
  provider: "openai" | "openai-compatible" | "anthropic" | "gemini";
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxConcurrency?: number;
}

export interface TenantConfig {
  tenantId: string;
  plan: "free" | "pro" | "enterprise";
  ai: TenantAIConfig;
}
