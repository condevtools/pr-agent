#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_IMAGE = "ghcr.io/lemonadeccc/pr-agent";
export const DEFAULT_BUILDER = "pr-agent-builder";
export const PLATFORMS = "linux/amd64,linux/arm64";
export const IMAGE_INPUT_PATHS = Object.freeze([
  "Dockerfile",
  ".dockerignore",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "backend/package.json",
  "backend/tsconfig.json",
  "backend/src",
  "backend/scripts",
]);

const TARGETS = new Set(["default", "verifier", "verifier-sandbox"]);
const IMAGE_PATTERN = /^(?=.{1,255}$)(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u;
const BUILDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");

export function parseArguments(arguments_) {
  const request = { action: undefined, dryRun: false, help: false, target: "default" };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") request.help = true;
    else if (argument === "--dry-run") request.dryRun = true;
    else if (argument === "--target") {
      const target = arguments_[index += 1];
      if (!target) throw new Error("--target requires default, verifier, or verifier-sandbox");
      request.target = target;
    } else if (argument.startsWith("--target=")) {
      request.target = argument.slice("--target=".length);
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (request.action === undefined) {
      request.action = argument;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }
  if (request.help) return request;
  if (!new Set(["build", "push", "inspect", "ref"]).has(request.action)) {
    throw new Error("Action must be one of: build, push, inspect, ref");
  }
  if (!TARGETS.has(request.target)) throw new Error(`Invalid target: ${request.target}`);
  if (request.dryRun && !new Set(["build", "push"]).has(request.action)) {
    throw new Error("--dry-run is supported only for build and push");
  }
  return request;
}

export function runDockerImageCli(arguments_, options = {}) {
  const request = parseArguments(arguments_);
  const write = options.write ?? ((line) => console.log(line));
  if (request.help) {
    write(helpText());
    return undefined;
  }

  const cwd = options.cwd ?? REPOSITORY_ROOT;
  const env = options.env ?? process.env;
  const execute = options.execute ?? executeProcess;
  const release = resolveRelease(request.target, env, cwd, execute);

  if (request.action === "ref") {
    write(release.reference);
    return release;
  }
  if (request.action === "inspect") {
    runChecked(execute, "docker", ["buildx", "imagetools", "inspect", release.reference], cwd, true);
    return release;
  }

  if (request.action === "push" && !request.dryRun) assertImageInputsClean(cwd, execute);
  const command = buildCommand(request.action, request.target, release, cwd);
  if (request.dryRun) {
    write(formatCommand(command.program, command.arguments));
    return { ...release, command };
  }

  ensureBuilder(release.builder, cwd, execute);
  if (request.action === "build") mkdirSync(dirname(command.archivePath), { recursive: true });
  runChecked(execute, command.program, command.arguments, cwd, true);
  write(request.action === "push"
    ? release.reference
    : `OCI archive: ${command.archivePath}`);
  return { ...release, command };
}

export function resolveRelease(target, env, cwd, execute) {
  if (!TARGETS.has(target)) throw new Error(`Invalid target: ${target}`);
  const configuredImage = env.PR_AGENT_IMAGE;
  const image = configuredImage ?? `${DEFAULT_IMAGE}${target === "default" ? "" : `-${target}`}`;
  const builder = env.PR_AGENT_BUILDER ?? DEFAULT_BUILDER;
  const tag = env.PR_AGENT_TAG ?? `sha-${readGitRevision(cwd, execute)}`;
  validateValue("image", image, IMAGE_PATTERN);
  validateValue("tag", tag, TAG_PATTERN);
  validateValue("builder", builder, BUILDER_PATTERN);
  return { image, tag, builder, reference: `${image}:${tag}` };
}

export function buildCommand(action, target, release, cwd) {
  const common = [
    "buildx", "build",
    "--builder", release.builder,
    "--platform", PLATFORMS,
    "--target", target,
    "--tag", release.reference,
  ];
  if (action === "push") {
    return { program: "docker", arguments: [...common, "--push", "."] };
  }
  const archiveName = `${basename(release.image)}-${release.tag}-${target}.oci.tar`;
  const archivePath = join(cwd, "dist", "docker", archiveName);
  return {
    program: "docker",
    arguments: [...common, "--output", `type=oci,dest=${archivePath}`, "."],
    archivePath,
  };
}

export function assertImageInputsClean(cwd, execute) {
  const result = runChecked(execute, "git", [
    "status", "--porcelain=v1", "--untracked-files=all", "--", ...IMAGE_INPUT_PATHS,
  ], cwd);
  const changes = result.stdout.trim();
  if (changes) {
    throw new Error(
      "Refusing to push a commit-tagged image because image inputs are modified or untracked:\n" + changes,
    );
  }
}

function readGitRevision(cwd, execute) {
  const revision = runChecked(execute, "git", ["rev-parse", "--short=12", "HEAD"], cwd).stdout.trim();
  if (!/^[0-9a-f]{7,40}$/u.test(revision)) throw new Error("Git returned an invalid revision");
  return revision;
}

function ensureBuilder(builder, cwd, execute) {
  const inspected = execute("docker", ["buildx", "inspect", builder], { cwd });
  if (inspected.status === 0) return;
  runChecked(execute, "docker", [
    "buildx", "create", "--name", builder, "--driver", "docker-container",
  ], cwd);
}

function executeProcess(program, arguments_, options) {
  const result = spawnSync(program, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.visible ? "inherit" : ["inherit", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runChecked(execute, program, arguments_, cwd, visible = false) {
  const result = execute(program, arguments_, { cwd, visible });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`${formatCommand(program, arguments_)} failed with exit code ${result.status}${
      detail ? `:\n${detail}` : ""}`);
  }
  return result;
}

function validateValue(name, value, pattern) {
  if (typeof value !== "string" || !pattern.test(value) || value.includes("..")) {
    throw new Error(`Invalid ${name}: ${JSON.stringify(value)}`);
  }
}

function formatCommand(program, arguments_) {
  return [program, ...arguments_].map((value) => /[\s'"\\]/u.test(value) ? JSON.stringify(value) : value).join(" ");
}

function helpText() {
  return `Usage: node scripts/docker-image.mjs <build|push|inspect|ref> [options]

Options:
  --target <default|verifier|verifier-sandbox>  Dockerfile target (default: default)
  --dry-run                                      Preview build/push without Docker
  -h, --help                                     Show this help

Environment overrides: PR_AGENT_IMAGE, PR_AGENT_TAG, PR_AGENT_BUILDER`;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    runDockerImageCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
