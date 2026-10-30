process.env.NODE_ENV = "test";
if (process.env.PR_AGENT_TEST_PUBLICATION_MODE && process.env.PR_AGENT_TEST_PUBLICATION_MODE !== "postgres") {
  throw new Error("PR_AGENT_TEST_PUBLICATION_MODE only supports postgres");
}
process.env.HARNESS_PUBLICATION_MODE = "postgres";
