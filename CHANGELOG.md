# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-03

### Added

- `/git pull` command: runs `git fetch --prune` followed by `git pull`.
- `/git branch` command: lists local branches, marking the current one and local-only branches.
- `/git branch <name>` command: switches to an existing branch or, after confirmation, creates it from the current one.
- Autocomplete for `/git` subcommands and local branch names.
- Git-aware footer showing the current branch with incoming/outgoing commit counters (`↓` / `↑`), refreshed periodically.

[0.1.0]: https://github.com/svyaddict/pi-git-commands/releases/tag/v0.1.0
