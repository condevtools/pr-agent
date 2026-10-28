// Legacy writer regression fixtures run only inside the isolated test process.
// Live entry points independently latch PostgreSQL authority and reject legacy.
process.env.NODE_ENV = "test";
process.env.HARNESS_PUBLICATION_MODE = "legacy";
