import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_IMAGE,
  IMAGE_INPUT_PATHS,
  PLATFORMS,
  runDockerImageCli,
} from "../../../scripts/docker-image.mjs";

type Invocation = { program: string; arguments: string[] };
type Result = { status: number; stdout: string; stderr: string };

const cleanEnvironment = { PR_AGENT_TAG: "sha-123456789abc" };

test("build plans an OCI archive for both architectures without env or secret arguments", () => {
  const workspace = mkdtempSync(join(tmpdir(), "pr-agent-image-test-"));
  const invocations: Invocation[] = [];
  const output: string[] = [];
  try {
    runDockerImageCli(["build"], {
      cwd: workspace,
      env: cleanEnvironment,
      execute: recorder(invocations),
      write: (line: string) => output.push(line),
    });

    assert.deepEqual(invocations[0], {
      program: "docker",
      arguments: ["buildx", "inspect", "pr-agent-builder"],
    });
    const build = invocations.at(-1);
    assert.equal(build?.program, "docker");
    assert.ok(build?.arguments.includes(PLATFORMS));
    const archive = `${workspace}/dist/docker/pr-agent-sha-123456789abc-default.oci.tar`;
    assert.ok(build?.arguments.includes(`type=oci,dest=${archive}`));
    assert.ok(!build?.arguments.some((argument) => argument === "--build-arg" || argument === "--secret" ||
      argument.includes(".env")));
    assert.deepEqual(output, [`OCI archive: ${archive}`]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("push rejects dirty image inputs before invoking Docker", () => {
  const invocations: Invocation[] = [];
  const execute = (program: string, arguments_: string[]): Result => {
    invocations.push({ program, arguments: arguments_ });
    if (program === "git") return { status: 0, stdout: " M backend/src/main.ts\n?? backend/scripts/local.mjs\n", stderr: "" };
    throw new Error("Docker must not run for dirty image inputs");
  };

  assert.throws(() => runDockerImageCli(["push"], {
    cwd: "/workspace", env: cleanEnvironment, execute, write: () => undefined,
  }), /Refusing to push.*backend\/src\/main\.ts/su);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0]?.program, "git");
});

test("push cleanliness scope excludes local secrets and agent metadata", () => {
  assert.ok(IMAGE_INPUT_PATHS.includes("backend/src"));
  assert.ok(IMAGE_INPUT_PATHS.includes("backend/scripts"));
  for (const unrelated of [".env", "secrets", ".codex", ".omx"]) {
    assert.ok(!IMAGE_INPUT_PATHS.some((path) => path === unrelated || path.startsWith(`${unrelated}/`)));
  }

  const invocations: Invocation[] = [];
  runDockerImageCli(["push", "--dry-run"], {
    cwd: "/workspace",
    env: cleanEnvironment,
    execute: recorder(invocations),
    write: () => undefined,
  });
  assert.deepEqual(invocations, []);
});

test("target suffixes, exact image overrides, and dry-run avoid Docker", () => {
  const suffixOutput: string[] = [];
  runDockerImageCli(["build", "--target", "verifier", "--dry-run"], {
    cwd: "/workspace",
    env: cleanEnvironment,
    execute: () => { throw new Error("dry-run must not execute child processes when tag is configured"); },
    write: (line: string) => suffixOutput.push(line),
  });
  assert.match(suffixOutput[0] ?? "", new RegExp(`${DEFAULT_IMAGE}-verifier:sha-123456789abc`, "u"));
  assert.match(suffixOutput[0] ?? "", /--platform linux\/amd64,linux\/arm64/u);

  const referenceOutput: string[] = [];
  runDockerImageCli(["ref", "--target=verifier-sandbox"], {
    cwd: "/workspace",
    env: { ...cleanEnvironment, PR_AGENT_IMAGE: "ghcr.io/acme/exact-image" },
    execute: () => { throw new Error("ref must not invoke Docker"); },
    write: (line: string) => referenceOutput.push(line),
  });
  assert.deepEqual(referenceOutput, ["ghcr.io/acme/exact-image:sha-123456789abc"]);
});

test("default tags use the twelve-character Git revision and inspect uses imagetools", () => {
  const invocations: Invocation[] = [];
  runDockerImageCli(["inspect", "--target", "verifier-sandbox"], {
    cwd: "/workspace",
    env: {},
    execute: (program: string, arguments_: string[]): Result => {
      invocations.push({ program, arguments: arguments_ });
      return program === "git"
        ? { status: 0, stdout: "123456789abc\n", stderr: "" }
        : { status: 0, stdout: "fixture manifest", stderr: "" };
    },
    write: () => undefined,
  });
  assert.deepEqual(invocations, [
    { program: "git", arguments: ["rev-parse", "--short=12", "HEAD"] },
    { program: "docker", arguments: ["buildx", "imagetools", "inspect",
      `${DEFAULT_IMAGE}-verifier-sandbox:sha-123456789abc`] },
  ]);
});

test("child process failures propagate and prevent the build", () => {
  const invocations: Invocation[] = [];
  const execute = (program: string, arguments_: string[]): Result => {
    invocations.push({ program, arguments: arguments_ });
    if (arguments_[1] === "inspect") return { status: 1, stdout: "", stderr: "missing" };
    if (arguments_[1] === "create") return { status: 17, stdout: "", stderr: "daemon unavailable" };
    return { status: 0, stdout: "", stderr: "" };
  };

  assert.throws(() => runDockerImageCli(["build"], {
    cwd: "/workspace", env: cleanEnvironment, execute, write: () => undefined,
  }), /failed with exit code 17.*daemon unavailable/su);
  assert.equal(invocations.some(({ arguments: arguments_ }) => arguments_[1] === "build"), false);
});

test("invalid image, tag, builder, and target values are rejected before Docker", () => {
  for (const env of [
    { ...cleanEnvironment, PR_AGENT_IMAGE: "--push" },
    { PR_AGENT_TAG: "-latest" },
    { ...cleanEnvironment, PR_AGENT_BUILDER: "../builder" },
  ]) {
    assert.throws(() => runDockerImageCli(["build", "--dry-run"], {
      cwd: "/workspace", env, execute: gitRevision, write: () => undefined,
    }), /Invalid/u);
  }
  assert.throws(() => runDockerImageCli(["build", "--target", "../default", "--dry-run"], {
    cwd: "/workspace", env: cleanEnvironment, execute: gitRevision, write: () => undefined,
  }), /Invalid target/u);
});

function recorder(invocations: Invocation[]) {
  return (program: string, arguments_: string[]): Result => {
    invocations.push({ program, arguments: arguments_ });
    return { status: 0, stdout: "", stderr: "" };
  };
}

function gitRevision(program: string): Result {
  if (program === "git") return { status: 0, stdout: "123456789abc\n", stderr: "" };
  throw new Error("Docker must not run");
}
