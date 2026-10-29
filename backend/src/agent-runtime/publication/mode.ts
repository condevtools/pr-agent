let onlineAuthorityRequired = false;

export function isDurablePublicationEnabled(): boolean {
  const isolatedTest = process.env.NODE_ENV === "test" && !onlineAuthorityRequired;
  const mode = process.env.HARNESS_PUBLICATION_MODE?.trim() || (isolatedTest ? "legacy" : "postgres");
  if (mode !== "legacy" && mode !== "postgres") {
    throw new Error("HARNESS_PUBLICATION_MODE must be legacy or postgres");
  }
  if (!isolatedTest && mode !== "postgres") {
    throw new Error("Online publication requires PostgreSQL authority; rollback to a bare legacy publisher is prohibited");
  }
  return mode === "postgres";
}

/** Called by every live server entry point; this latch is never reset by env changes. */
export function requireOnlinePublicationAuthority(): void {
  onlineAuthorityRequired = true;
  isDurablePublicationEnabled();
}
