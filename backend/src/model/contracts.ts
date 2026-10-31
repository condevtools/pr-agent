export type StructuredModelRole = "security" | "correctness" | "critic" | "fix" | "evolution" | "issue-triage" | "judge";

export interface ModelPromptReference {
  name: string;
  version: number;
  contentHash: string;
}

export interface StructuredModelRequest<T> {
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  schema: { parse(value: unknown): T };
  systemPrompt: string;
  prompt: string;
  role: StructuredModelRole;
  turn: number;
  maxInputBytes: number;
  maxOutputTokens: number;
  promptReferences?: readonly ModelPromptReference[];
  signal?: AbortSignal;
}

export interface StructuredModel {
  generate<T>(request: StructuredModelRequest<T>): Promise<T>;
}
