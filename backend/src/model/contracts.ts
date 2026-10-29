export type StructuredModelRole = "security" | "correctness" | "critic" | "fix" | "evolution";

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
  signal?: AbortSignal;
}

export interface StructuredModel {
  generate<T>(request: StructuredModelRequest<T>): Promise<T>;
}
