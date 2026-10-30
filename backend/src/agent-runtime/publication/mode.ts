/** Live and test execution always require PostgreSQL publication authority. */
export function requireOnlinePublicationAuthority(): void {
  const configured = process.env.HARNESS_PUBLICATION_MODE?.trim();
  if (configured && configured !== "postgres") {
    throw new Error("HARNESS_PUBLICATION_MODE only supports postgres");
  }
}
