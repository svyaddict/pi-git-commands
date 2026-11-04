# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-04

### Added

- `/git status`: compact summary of conflicts, staged, unstaged and untracked files with ahead/behind counters.
- `/git fetch`: runs `git fetch --all --prune` and reports pruned branches and incoming commits.
- `/git push`: pushes the current branch; without upstream it picks the remote, asks for confirmation and sets the upstream. Rejected pushes suggest `/git pull`.
- `/git cleanup`: deletes local branches whose upstream is gone or that were pushed and merged into the default branch, after confirmation; asks before force-deleting branches merged with squash or rebase. Never offers protected branches, branches checked out in a worktree, or branches that were never pushed or point exactly at the default branch (git considers a branch just created from `main` merged).
- `/git branch <name>` now checks out branches that exist only on a remote, creating a local branch that tracks it (asks which remote when several have it).
- Autocomplete also suggests remote-only branches.
- Footer shows `(sub)` next to the cost when the active provider is subscription-backed, like the built-in footer.
- `/git pull` on a branch without upstream offers to track the same-named remote branch, or explains that the branch must be pushed first, instead of failing with git's raw error.
- Footer counters also work on branches without upstream: they compare against the same-named remote branch, or count unpushed commits for branches that were never pushed.
- `/git footer [on|off]`: shows or changes whether the git footer replaces pi's built-in one. The footer stays on by default; the choice applies right away and is saved in `~/.pi/agent/pi-git-commands.json`, so every pi session in every terminal follows it. Works outside git repositories too. Autocomplete suggests `on` and `off`.
- Automated tests (`npm test`): unit tests for parsers, messages and cleanup decisions, and integration tests that run the commands against real repositories with a local bare remote.
- CI on every push and pull request: Biome lint/format, typecheck, and tests on Linux, Windows and macOS with Node 22.19 and 24. Releases run it before publishing.

### Changed

- **Breaking:** `/git pull` only fast-forwards (`git pull --ff-only --prune`, one fetch instead of two), whatever `pull.rebase` says. Diverged branches are reported and left untouched instead of being merged or rebased. 120 s timeout and a shorter success summary.
- git never prompts: commands run with `GIT_TERMINAL_PROMPT=0`, the Git Credential Manager in non-interactive mode and, on POSIX, without a controlling terminal. Missing credentials fail right away instead of blocking until the timeout.
- git messages are always in English (`LC_ALL=C`), so the messages the extension recognizes are detected on localized systems too.
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
- On timeout, git is terminated together with its child processes (ssh, credential helpers, hooks); on Windows they used to keep running. A terminated command is always reported as failed.
- `/git` reports when git is not installed instead of saying the directory is not a repository.
- A failed or timed-out git query is reported as an error instead of being taken as missing data: `/git pull` and `/git push` no longer offer to set an upstream that already exists, and no command claims a detached HEAD when git could not read the branch.
- An unexpected error in a subcommand is reported as a notification instead of escaping the command handler.
- The footer no longer starts a new refresh while the previous one is still running on slow repositories.

## [0.1.0] - 2026-11-03

### Added

- `/git pull` command: runs `git fetch --prune` followed by `git pull`.
- `/git branch` command: lists local branches, marking the current one and local-only branches.
- `/git branch <name>` command: switches to an existing branch or, after confirmation, creates it from the current one.
- Autocomplete for `/git` subcommands and local branch names.
- Git-aware footer showing the current branch with incoming/outgoing commit counters (`↓` / `↑`), refreshed periodically.

[Unreleased]: https://github.com/svyaddict/pi-git-commands/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/svyaddict/pi-git-commands/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/svyaddict/pi-git-commands/releases/tag/v0.1.0
