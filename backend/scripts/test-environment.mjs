process.env.NODE_ENV = "test";
const publicationMode = process.env.PR_AGENT_TEST_PUBLICATION_MODE ?? "postgres";
if (publicationMode !== "postgres" && publicationMode !== "legacy") {
  throw new Error("PR_AGENT_TEST_PUBLICATION_MODE must be postgres or legacy");
}
process.env.HARNESS_PUBLICATION_MODE = publicationMode;
