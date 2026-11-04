# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `/git status`: compact summary of conflicts, staged, unstaged and untracked files with ahead/behind counters.
- `/git fetch`: runs `git fetch --all --prune` and reports pruned branches and incoming commits.
- `/git push`: pushes the current branch; without upstream it picks the remote, asks for confirmation and sets the upstream. Rejected pushes suggest `/git pull`.
- `/git cleanup`: deletes local branches whose upstream is gone or that are merged into the default branch, after confirmation; asks before force-deleting branches merged with squash or rebase.
- `/git branch <name>` now checks out branches that exist only on a remote, creating a local branch that tracks it (asks which remote when several have it).
- Autocomplete also suggests remote-only branches.
- Footer shows `(sub)` next to the cost when the active provider is subscription-backed, like the built-in footer.
- `/git pull` on a branch without upstream offers to track the same-named remote branch, or explains that the branch must be pushed first, instead of failing with git's raw error.
- Footer counters also work on branches without upstream: they compare against the same-named remote branch, or count unpushed commits for branches that were never pushed.
- `PI_GIT_FOOTER=off` environment variable to keep the `/git` command without replacing the footer.

### Changed

- `/git pull` now runs a single `git pull --prune` (one fetch instead of two), with a 120 s timeout and a shorter success summary.
- Branch switching and creation use `git switch` / `git switch --create`.
- Footer counters refresh immediately after every `/git` command.
- The extension is split into modules (`git.ts`, `footer.ts`, `autocomplete.ts`, one file per command) instead of a single file. Subcommands are declared in one table that drives dispatch, usage text and autocomplete.
- Documentation moved to `docs/` (commands, footer, installation, development) and `CONTRIBUTING.md`; the README keeps features, a command table and quick install.
- `/git <subcommand>` with unexpected arguments now reports an error instead of "Unknown command".

### Fixed

- `/git branch <name>` for a branch that exists only on a remote created a new, unrelated branch from the current one.
- Branch names are validated (`git check-ref-format --branch`): names with whitespace or starting with `-` are rejected instead of being passed to git.
- Selecting a branch suggestion right after `/git branch` (no space) produced `/git branchmain`.
- `/git` autocomplete no longer captures other commands starting with `/git` (e.g. `/github`).
- Footer showed `(auto)` even when auto-compaction was disabled.
- Footer showed `0.0%` instead of `?` when context usage was unavailable.
- Footer recomputed session usage totals on every render; they are now cached.
- Timeouts are reported as such instead of as an empty error.

## [0.1.0] - 2026-11-03

### Added

- `/git pull` command: runs `git fetch --prune` followed by `git pull`.
- `/git branch` command: lists local branches, marking the current one and local-only branches.
- `/git branch <name>` command: switches to an existing branch or, after confirmation, creates it from the current one.
- Autocomplete for `/git` subcommands and local branch names.
- Git-aware footer showing the current branch with incoming/outgoing commit counters (`↓` / `↑`), refreshed periodically.

[Unreleased]: https://github.com/svyaddict/pi-git-commands/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/svyaddict/pi-git-commands/releases/tag/v0.1.0
