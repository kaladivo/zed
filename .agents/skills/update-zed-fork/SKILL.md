---
name: update-zed-fork
description: Update this project’s Zed fork to the latest official stable release. Use when the user wants to check for new stable Zed releases, rebase fork commits while preserving feature intent, force-push the fork branch after confirmation, then use build-zed-fork to build the macOS app bundle and optionally replace the installed app.
---

# Update Zed Fork

Use this skill to carry a personal Zed fork forward to the latest official stable release while preserving the user’s fork-specific features.

## Repository Assumptions

- Run from the Zed repo root.
- `origin` is the official `zed-industries/zed` remote.
- The user’s fork remote may be named differently; detect it with `git remote -v` and choose the writable non-official remote.
- Stable releases are official tags like `v1.0.0`; ignore prerelease tags ending in `-pre`.
- The current branch contains the user’s fork commits on top of an official stable tag.

## Workflow

### 1. Check Stable Releases

Fetch official refs first so build-time `ZED_UPSTREAM_BASE_VERSION` can be computed correctly later:

```bash
git fetch origin --tags --prune
```

Find the current upstream base and latest official stable tag:

```bash
current_base=$(git describe --tags --match 'v[0-9]*' --exclude '*-pre' --abbrev=0 HEAD)
latest_stable=$(git tag --list 'v[0-9]*' --sort=-version:refname | grep -v -- '-pre$' | head -1)
```

If `current_base` equals `latest_stable`, stop. Tell the user there is no newer stable release and include the tag.

### 2. Understand Fork Intent

Before rebasing, summarize the user’s fork commits and their likely feature intent:

```bash
git log --reverse --oneline "${current_base}..HEAD"
git diff --stat "${current_base}..HEAD"
git diff --find-renames "${current_base}..HEAD"
```

Use this to build a feature-level summary such as “disables agent AI through a setting” instead of a file-by-file implementation summary.

### 3. Rebase Onto Latest Stable

Create a recoverable pointer before changing history:

```bash
backup_branch="backup/$(git branch --show-current)-before-${latest_stable}"
git branch "$backup_branch"
```

Rebase the current branch onto the latest stable tag:

```bash
git rebase --onto "$latest_stable" "$current_base"
```

Resolve conflicts by preserving the intent of the user’s commits while accepting upstream changes where they do not affect the fork feature. Inspect both sides of conflicts and nearby code before editing.

If a conflict reflects a product or feature decision, pause and ask the user in feature-level terms. Avoid overly technical questions. Good examples:

- “Upstream changed how this setting is named and displayed. Should your fork keep the old user-facing wording, or follow upstream wording while preserving the same behavior?”
- “Upstream moved this feature into a different UI area. Should your fork keep disabling it everywhere, or only in the original places you changed?”

Do not force-push or build while unresolved decisions remain.

### 4. Verify Rebase

After the rebase completes:

```bash
git status --short
git log --reverse --oneline "${latest_stable}..HEAD"
git diff --stat "$latest_stable..HEAD"
```

Run focused checks for changed Rust crates. Prefer `./script/clippy` for linting if a clippy check is needed. At minimum, run a reasonable `cargo check` for touched packages when feasible.

Give the user a quick feature-level summary of what changed, including whether the fork behavior changed. Then wait for explicit confirmation before pushing or building.

### 5. Push After Confirmation

After the user confirms, force-push only the current branch to the fork remote using lease protection:

```bash
branch=$(git branch --show-current)
git push --force-with-lease <fork-remote> "$branch"
```

Use the user’s existing git identity. Do not alter authorship. If committing during conflict resolution, always use `git commit --no-gpg-sign`.

### 6. Build Current Platform

Use the repo-local `build-zed-fork` skill for all build and install work. That skill owns `ZED_UPSTREAM_BASE_VERSION` detection, macOS bundling, copying the app to `<repo>/zed.app`, reporting the app path, and any installation prompt.

Run:

```bash
bun .agents/skills/build-zed-fork/scripts/build-zed-app.ts
```

Report the emitted `APP_PATH=...` value to the user.

## Output Style

Keep user-facing summaries feature-oriented:

- Current base and latest stable tag.
- Fork features detected from commits.
- Rebase conflicts or decisions, if any.
- Post-rebase feature behavior.
- Push result and built app location.

Avoid asking the user to make code-level choices unless there is no feature-level framing available.
