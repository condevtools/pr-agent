export function extractModelText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (
          part &&
          typeof part === "object" &&
          "type" in part &&
          "text" in part &&
          (part as { type?: string }).type === "text"
        ) {
          return (part as { text?: string }).text ?? "";
        }

        return "";
      })
      .join("\n")
      .trim();

    if (text) {
      return text;
    }
  }

  throw new Error("Model returned empty content");
}

export function parseJsonFromModelText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Model returned empty text");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        // fall through
      }
    }

    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = trimmed.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        // fall through
      }

      // When multiple JSON objects are mixed with text (e.g. thinking tokens
      // + tool calls + answer), scan backwards from the last "}" to find the
      // last valid JSON object.
      for (
        let searchPos = lastBrace;
        searchPos > firstBrace;
      ) {
        const openPos = trimmed.lastIndexOf("{", searchPos - 1);
        if (openPos < 0) break;
        const inner = trimmed.slice(openPos, lastBrace + 1);
        try {
          return JSON.parse(inner);
        } catch {
          searchPos = openPos;
        }
      }
    }

    throw new Error("Model response is not valid JSON");
  }
}
