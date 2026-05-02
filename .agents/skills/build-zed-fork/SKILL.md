---
name: build-zed-fork
description: Builds this Zed fork into a repo-local zed.app bundle, verifies the upstream base version from Git history, reports the built app path, and optionally replaces /Applications/Zed.app after asking the user. Use when working in this repo and the user wants to build, package, install, or replace their local macOS Zed fork.
---

# Build Zed Fork

Use this skill to build the current macOS Zed checkout into a project-local `zed.app` bundle and optionally replace the installed app in `/Applications`.

## Workflow

1. Confirm the current directory is inside the intended Zed fork.
2. Optionally verify detection without building:

```bash
bun .agents/skills/build-zed-fork/scripts/build-zed-app.ts --dry-run
```

3. Run the helper script from the repo checkout:

```bash
bun .agents/skills/build-zed-fork/scripts/build-zed-app.ts
```

4. Watch the script output for:
   - `Using ZED_UPSTREAM_BASE_VERSION=...`
   - `APP_PATH=...`
5. Present the `APP_PATH` value to the user.
6. Ask whether they want to replace `/Applications/Zed.app` with the built app.
7. Only if the user says yes, run:

```bash
bun .agents/skills/build-zed-fork/scripts/build-zed-app.ts --install
```

The second command rebuilds if needed, refreshes `<repo>/zed.app`, and replaces `/Applications/Zed.app`.

## Upstream Base Version

The helper computes the upstream base version from Git history using the same stable-tag rule used by `crates/zed/build.rs`:

```bash
git describe --tags --match 'v[0-9]*' --exclude '*-pre' --abbrev=0 HEAD
```

It strips the leading `v` and passes the result as `ZED_UPSTREAM_BASE_VERSION` while building. If no matching upstream stable tag exists, stop and report the failure.

## Output

The built app is copied to:

```text
<repo>/zed.app
```

The bundle still has Zed's internal app name and bundle identifier; `zed.app` is just the repo-local artifact path.

## Important Constraints

- Ask before replacing `/Applications/Zed.app`; do not install automatically unless the user explicitly requested installation in the same turn.
- Do not modify commit authorship or commit anything as part of this skill.
- If the build fails because Xcode is missing the Metal Toolchain, run:

```bash
xcodebuild -downloadComponent MetalToolchain
```

- If the build fails with `No space left on device`, report the available disk space and ask the user to free space before retrying.
