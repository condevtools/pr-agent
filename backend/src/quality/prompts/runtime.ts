import { AsyncLocalStorage } from "node:async_hooks";

import { MANAGED_PROMPT_CATALOG } from "./catalog.js";
import {
  parsePromptBundle,
  promptTemplateVariables,
  type ManagedPromptKey,
  type ManagedPromptReference,
  type PromptBundleV1,
} from "./contracts.js";

const MAX_RENDERED_PROMPT_BYTES = 1024 * 1024;
const promptBundleStorage = new AsyncLocalStorage<PromptBundleV1>();

export interface RenderedManagedPrompt {
  text: string;
  reference?: ManagedPromptReference;
}

export function withFrozenPromptBundle<T>(
  bundle: PromptBundleV1 | unknown,
  action: () => T,
): T {
  return promptBundleStorage.run(parsePromptBundle(bundle), action);
}

export function currentFrozenPromptBundle(): PromptBundleV1 | undefined {
  return promptBundleStorage.getStore();
}

export function renderManagedPrompt(
  key: ManagedPromptKey,
  variables: Readonly<Record<string, string>> = {},
  fallback: string = MANAGED_PROMPT_CATALOG[key].template,
): RenderedManagedPrompt {
  const snapshot = currentFrozenPromptBundle()?.prompts[key];
  const template = snapshot?.template ?? fallback;
  const required = promptTemplateVariables(template);
  const supplied = Object.keys(variables).sort();
  if (!same(required, supplied)) {
    throw new Error(`Managed prompt variables do not match ${key}`);
  }
  let text = template;
  for (const variable of required) {
    text = text.replaceAll(`{{${variable}}}`, variables[variable]!);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RENDERED_PROMPT_BYTES) {
    throw new Error(`Managed prompt exceeds the rendered size limit: ${key}`);
  }
  return {
    text,
    ...(snapshot ? { reference: {
      name: snapshot.name,
      version: snapshot.version,
      contentHash: snapshot.contentHash,
    } } : {}),
  };
}

export function managedPromptReferences(
  ...prompts: readonly RenderedManagedPrompt[]
): ManagedPromptReference[] | undefined {
  const references = prompts.flatMap((prompt) => prompt.reference ? [prompt.reference] : []);
  return references.length > 0 ? references : undefined;
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
