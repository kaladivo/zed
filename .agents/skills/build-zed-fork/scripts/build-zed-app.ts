#!/usr/bin/env bun

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

function runShell(script: string, options: RunOptions): string {
  return run("bash", ["-lc", script], options);
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

function releaseChannel(root: string): string {
  return readFileSync(join(root, "crates", "zed", "RELEASE_CHANNEL"), "utf8").trim();
}

function ensureCargoBundle(root: string): void {
  const cargoBundleVersion = runShell(
    "cargo -q bundle --help 2>&1 | head -n 1 || true",
    { cwd: root, capture: true },
  );

  if (cargoBundleVersion !== "cargo-bundle v0.6.1-zed") {
    run("cargo", [
      "install",
      "cargo-bundle",
      "--git",
      "https://github.com/zed-industries/cargo-bundle.git",
      "--branch",
      "zed-deploy",
    ], { cwd: root });
  }
}

function bundleApp(root: string, target: string, channel: string, env: NodeJS.ProcessEnv): string {
  const zedCrate = join(root, "crates", "zed");
  const cargoTomlPath = join(zedCrate, "Cargo.toml");
  const cargoToml = readFileSync(cargoTomlPath, "utf8");
  const bundleMetadataName = `package.metadata.bundle-${channel}`;

  if (!cargoToml.includes(bundleMetadataName)) {
    throw new Error(`Could not find ${bundleMetadataName} in ${cargoTomlPath}`);
  }

  writeFileSync(
    cargoTomlPath,
    cargoToml.replace(bundleMetadataName, "package.metadata.bundle"),
  );

  try {
    run("cargo", ["bundle", "--release", "--target", target, "--select-workspace-root"], {
      cwd: zedCrate,
      env: {
        ...env,
        CARGO_BUNDLE_SKIP_BUILD: "true",
      },
    });
  } finally {
    writeFileSync(cargoTomlPath, cargoToml);
  }

  const appPath = join(root, "target", target, "release", "bundle", "osx", "Zed.app");
  if (!existsSync(appPath)) {
    throw new Error(`Expected cargo bundle to create ${appPath}`);
  }

  return appPath;
}

function copyIfExists(source: string, destination: string): void {
  if (!existsSync(source)) {
    return;
  }

  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function downloadGit(root: string, target: string, destination: string): void {
  const gitVersion = "v2.43.3";
  const gitVersionSha = "fa29823";
  const tempDir = mkdtempSync(join(tmpdir(), "zed-git-"));

  const url =
    target === "aarch64-apple-darwin"
      ? `https://github.com/desktop/dugite-native/releases/download/${gitVersion}/dugite-native-${gitVersion}-${gitVersionSha}-macOS-arm64.tar.gz`
      : `https://github.com/desktop/dugite-native/releases/download/${gitVersion}/dugite-native-${gitVersion}-${gitVersionSha}-macOS-x64.tar.gz`;

  try {
    runShell(
      `curl --silent --fail --location ${JSON.stringify(url)} | tar -xvz -C ${JSON.stringify(tempDir)} -f - bin/git`,
      { cwd: root },
    );
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(join(tempDir, "bin", "git"), destination);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function adHocSignApp(root: string, appPath: string): void {
  const entitlementsPath = join(root, "crates", "zed", "resources", "zed.entitlements");
  const localEntitlementsPath = join(appPath, "Contents", "Resources", "zed.entitlements");
  const entitlements = readFileSync(entitlementsPath, "utf8").split("\n");
  const filteredEntitlements: string[] = [];

  for (let index = 0; index < entitlements.length; index += 1) {
    if (entitlements[index]?.includes("com.apple.developer.associated-domains")) {
      index += 1;
      continue;
    }

    filteredEntitlements.push(entitlements[index] ?? "");
  }

  writeFileSync(localEntitlementsPath, filteredEntitlements.join("\n"));
  run("codesign", [
    "--force",
    "--deep",
    "--entitlements",
    localEntitlementsPath,
    "--sign",
    process.env.MACOS_SIGNING_KEY ?? "-",
    appPath,
    "-v",
  ], { cwd: root });
}

function buildLocalApp(root: string, target: string, channel: string, env: NodeJS.ProcessEnv): string {
  ensureCargoBundle(root);

  run("script/generate-licenses", [], { cwd: root, env });
  run("rustup", ["target", "add", target], { cwd: root, env });

  console.log("Compiling zed app binaries");
  run("cargo", [
    "build",
    "--release",
    "--package",
    "zed",
    "--package",
    "cli",
    "--target",
    target,
  ], { cwd: root, env });

  console.log("Creating local application bundle");
  const appPath = bundleApp(root, target, channel, env);

  copyIfExists(
    join(root, "crates", "zed", "resources", "Document.icns"),
    join(appPath, "Contents", "Resources", "Document.icns"),
  );
  copyIfExists(
    join(root, "crates", "zed", "contents", channel, "embedded.provisionprofile"),
    join(appPath, "Contents", "embedded.provisionprofile"),
  );
  copyFileSync(
    join(root, "target", target, "release", "zed"),
    join(appPath, "Contents", "MacOS", "zed"),
  );
  copyFileSync(
    join(root, "target", target, "release", "cli"),
    join(appPath, "Contents", "MacOS", "cli"),
  );

  console.log("Downloading bundled git binary");
  downloadGit(root, target, join(appPath, "Contents", "MacOS", "git"));

  console.log("Ad-hoc signing local app bundle");
  adHocSignApp(root, appPath);

  return appPath;
}

function usage(exitCode = 2): never {
  console.error(`Usage: build-zed-app.ts [--install]

Builds the current Zed checkout into <repo>/zed.app without release-only artifacts.

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
const baseVersion = upstreamBaseVersion(root);
const target = targetTriple();
const channel = releaseChannel(root);
const env = {
  ...process.env,
  ZED_UPSTREAM_BASE_VERSION: baseVersion,
  ZED_RELEASE_CHANNEL: channel,
  ZED_BUNDLE: "true",
  CXXFLAGS: "-stdlib=libc++",
};

console.log(`Using ZED_UPSTREAM_BASE_VERSION=${baseVersion}`);
console.log(`Building target ${target}`);
console.log(`Building release channel ${channel}`);
console.log("Skipping release-only remote_server, Sentry, and DMG artifacts");
if (dryRun) {
  console.log(`REPO_ROOT=${root}`);
  process.exit(0);
}

const appSource = buildLocalApp(root, target, channel, env);

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
