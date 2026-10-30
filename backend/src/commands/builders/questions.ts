export function buildImproveRule(focus: string): string {
  const normalizedFocus = focus.trim();
  if (normalizedFocus) {
    return `Focus mode: improvement suggestions only. Prioritize high-impact fixes related to: ${normalizedFocus}. Prefer concrete code suggestions when possible.`;
  }
  return "Focus mode: improvement suggestions only. Prioritize high-impact fixes and include concrete code suggestions when possible.";
}

export function buildAddDocRule(focus: string): string {
  const normalizedFocus = focus.trim();
  if (normalizedFocus) {
    return `Focus mode: docstrings/comments only. Improve developer-facing documentation for: ${normalizedFocus}. Output only doc-related findings with concrete snippets.`;
  }
  return "Focus mode: docstrings/comments only. Output only documentation-related findings with concrete doc snippet suggestions.";
}

export function buildImproveComponentRule(component: string): string {
  const normalizedComponent = component.trim();
  if (!normalizedComponent) {
    return "Focus mode: improvement suggestions only. Prioritize high-impact fixes and include concrete code suggestions when possible.";
  }
  return `Focus mode: improvement suggestions only. Focus exclusively on the component: ${normalizedComponent}. Ignore all changes outside this component. Prioritize high-impact fixes and include concrete code suggestions when possible.`;
}
