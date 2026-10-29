import { z } from "zod";

export const reviewStrategyTextSchema = z.object({
  schemaVersion: z.literal(1),
  prompt_text: z.string().min(1).max(32_768),
  tool_description_text: z.string().min(1).max(32_768),
}).strict();

export type ReviewStrategyText = z.infer<typeof reviewStrategyTextSchema>;

export const reviewStrategyTextJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    prompt_text: { type: "string", minLength: 1, maxLength: 32_768 },
    tool_description_text: { type: "string", minLength: 1, maxLength: 32_768 },
  },
  required: ["schemaVersion", "prompt_text", "tool_description_text"],
} as const;
