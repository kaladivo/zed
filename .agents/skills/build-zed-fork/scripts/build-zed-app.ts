#!/usr/bin/env bun

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type RunOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  capture?: boolean;
};

function run(command: string, args: string[], options: RunOptions): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.status !== 0) {
    const details = options.capture
      ? `\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      : "";
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}${details}`,
    );
  }

  return (result.stdout ?? "").trim();
}

function repoRoot(): string {
  return run("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    capture: true,
  });
}

function upstreamBaseVersion(root: string): string {
  const tag = run(
    "git",
    [
      "describe",
      "--tags",
      "--match",
      "v[0-9]*",
      "--exclude",
      "*-pre",
      "--abbrev=0",
      "HEAD",
    ],
    { cwd: root, capture: true },
  );

  if (!tag.startsWith("v")) {
    throw new Error(`Expected upstream base tag to start with "v", got ${tag}`);
  }

  return tag.slice(1);
}

function targetTriple(): string {
  const arch = run("uname", ["-m"], { cwd: process.cwd(), capture: true });

  if (arch === "arm64") {
    return "aarch64-apple-darwin";
  }

  if (arch === "x86_64") {
    return "x86_64-apple-darwin";
  }

  throw new Error(`Unsupported macOS architecture: ${arch}`);
}

function usage(exitCode = 2): never {
  console.error(`Usage: build-zed-app.ts [--install]

Builds the current Zed checkout into <repo>/zed.app.

Options:
  --dry-run   Print the detected repo, upstream base version, and target without building.
  --install   Replace /Applications/Zed.app with the built app after copying it to the repo.
`);
  process.exit(exitCode);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  usage(0);
}

const install = args.includes("--install");
const dryRun = args.includes("--dry-run");
const unknownArgs = args.filter((arg) => arg !== "--install" && arg !== "--dry-run");
if (unknownArgs.length > 0) {
  usage();
}

const root = repoRoot();
const bundleScript = join(root, "script", "bundle-mac");
if (!existsSync(bundleScript)) {
  throw new Error(`Expected Zed bundle script at ${bundleScript}`);
}

const baseVersion = upstreamBaseVersion(root);
const target = targetTriple();
const env = {
  ...process.env,
  ZED_UPSTREAM_BASE_VERSION: baseVersion,
};

console.log(`Using ZED_UPSTREAM_BASE_VERSION=${baseVersion}`);
console.log(`Building target ${target}`);
if (dryRun) {
  console.log(`REPO_ROOT=${root}`);
  process.exit(0);
}

run(bundleScript, [target], { cwd: root, env });

const appSources = [
  join(root, "target", target, "release", "dmg", "Zed.app"),
  join(root, "target", target, "release", "bundle", "osx", "Zed.app"),
];
const appSource = appSources.find((path) => existsSync(path));
if (!appSource) {
  throw new Error(`Could not find built app. Checked:\n${appSources.join("\n")}`);
}

const projectAppPath = join(root, "zed.app");
rmSync(projectAppPath, { recursive: true, force: true });
run("ditto", [appSource, projectAppPath], { cwd: root });

console.log(`APP_PATH=${projectAppPath}`);

if (install) {
  const applicationsPath = "/Applications/Zed.app";
  console.log(`Replacing ${applicationsPath}`);
  rmSync(applicationsPath, { recursive: true, force: true });
  run("ditto", [projectAppPath, applicationsPath], { cwd: root });
  console.log(`INSTALLED_APP_PATH=${applicationsPath}`);
}
