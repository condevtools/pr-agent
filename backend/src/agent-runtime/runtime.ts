// Compatibility surface. New low-level modules import a leaf under runtime/ so
// workflow code never depends on the composition root that imports workflows.
export { requireOnlinePublicationAuthority } from "./publication/mode.js";
export { agentRuntimePoolConfig, resolveAgentProcessRole, roleStartsWeb,
  type AgentProcessRole } from "./runtime/config.js";
export { getAgentRuntimeServices } from "./runtime/services.js";
export { resolvePublicationRuntime, publicationRuntimeForBinding,
  type PublicationRuntime } from "./runtime/publication.js";
export { validatePublicationCredentialOrigin } from "./runtime/credentials.js";

import type { PublicationBinding } from "./authority/publication-authority.js";
import type { RunLease } from "./runs/contracts.js";
import { runtimeComposition } from "./runtime/composition.js";

export function startPublicationRecovery(): Promise<void> { return runtimeComposition().startRecovery(); }
export function stopPublicationRecovery(): Promise<void> { return runtimeComposition().stopRecovery(); }
export function startRunWorker(): Promise<void> { return runtimeComposition().startWorker(); }
export function stopRunWorker(): Promise<void> { return runtimeComposition().stopWorker(); }
export function quiesceAgentRuntime(): Promise<void> { return runtimeComposition().quiesce(); }
export function closeAgentRuntimeApplicationResources(): Promise<void> {
  return runtimeComposition().closeApplicationResources();
}
export function closeAgentRuntime(): Promise<void> { return runtimeComposition().close(); }
export function executeAgentRun(lease: RunLease, binding: PublicationBinding): Promise<void> {
  return runtimeComposition().executeRun(lease, binding);
}
export function agentRuntimeRoleStatus() { return runtimeComposition().status(); }
