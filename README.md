# pi-git-commands

[![npm version](https://img.shields.io/npm/v/@svyaddict/pi-git-commands.svg)](https://www.npmjs.com/package/@svyaddict/pi-git-commands)
[![npm downloads](https://img.shields.io/npm/dm/@svyaddict/pi-git-commands.svg)](https://www.npmjs.com/package/@svyaddict/pi-git-commands)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![pi package](https://img.shields.io/badge/pi-package-blue)](https://pi.dev/packages)

> Everyday git workflow, right inside [pi](https://pi.dev) — pull, switch and create branches without leaving the agent, and always know whether you are ahead or behind your upstream.

`pi-git-commands` is a [pi package](https://pi.dev/packages) that adds a `/git` slash command with branch autocomplete and replaces the default footer with a git-aware one showing incoming/outgoing commit counters.

---

## Table of contents

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
  - [`/git pull`](#git-pull)
  - [`/git branch`](#git-branch)
  - [Autocomplete](#autocomplete)
  - [Git-aware footer](#git-aware-footer)
- [Requirements](#requirements)
- [Compatibility notes](#compatibility-notes)
- [Development](#development)
- [Contributing](#contributing)
- [Changelog](#changelog)
- [License](#license)

## Features

- 🔄 **`/git pull`** — pull and prune stale remote-tracking branches in a single command (`git pull --prune`).
- 🌿 **`/git branch`** — list local branches, highlighting the current one and branches that exist only locally.
- 🔀 **`/git branch <name>`** — switch to a local branch, check out a remote branch with tracking, or create a new branch (with confirmation).
- ⌨️ **Autocomplete** — subcommands, local branches and remote-only branches are suggested as you type.
- 📊 **Git-aware footer** — current branch with `↓incoming ↑outgoing` commit counters, refreshed automatically, alongside the usual token, cost and context stats.

## Installation

Install from npm with the pi CLI:

```bash
pi install npm:@svyaddict/pi-git-commands
```

Or directly from GitHub:

```bash
pi install git:github.com/svyaddict/pi-git-commands
```

Install it for the current project only (written to `.pi/settings.json`):

```bash
pi install -l npm:@svyaddict/pi-git-commands
```

Try it for a single session without installing:

```bash
pi -e npm:@svyaddict/pi-git-commands
```

To remove it:

```bash
pi remove npm:@svyaddict/pi-git-commands
```

## Usage

The extension activates automatically when pi starts inside a git repository.

### `/git pull`

```text
/git pull
```

Runs `git pull --prune` in the current working directory: it fetches, removes remote-tracking branches that no longer exist on the remote, and merges or rebases according to your git configuration. The result is reported as a short notification. The command times out after 120 seconds.

If the current branch has no upstream:

- and a branch with the same name exists on a remote, pi offers to set it as upstream (`git branch --set-upstream-to`) and then pulls;
- otherwise pi explains that there is nothing to pull and suggests pushing the branch with `git push -u`.

### `/git branch`

List local branches:

```text
/git branch
```

```text
Local branches:
> main
  feature/login*
  develop

* = local-only branch (not present on any remote)
```

- `>` marks the current branch.
- `*` marks branches that do not exist on any remote.

Switch to a branch, or create it:

```text
/git branch feature/login
```

1. If the branch exists locally, pi switches to it (`git switch`).
2. If it exists only on a remote, pi creates a local branch that tracks it (`git switch --create <name> --track <remote>/<name>`). When several remotes have a branch with that name, pi asks which one to track.
3. Otherwise pi asks for confirmation and creates it from the current branch (`git switch --create`).

The name is validated with `git check-ref-format --branch` first, so invalid names (with spaces, starting with `-`, containing `..`, …) are rejected. Git shorthands such as `@{-1}` (the previously checked-out branch) work too.

### Autocomplete

- Typing `/git ` suggests the available subcommands (`pull`, `branch`).
- Typing `/git branch ` suggests local branches, annotated as *current branch*, *local only* or *present on remote*, followed by branches that exist only on a remote, annotated as *remote only (origin)*.

### Git-aware footer

In interactive (TUI) mode the footer shows:

```text
~/projects/my-app (main ↓2 ↑1) • my-session
↑12k ↓3.4k R45k W8k CH78.3% $0.123 21.4%/200k (auto)        (anthropic) claude-sonnet • medium
```

- `↓N` — commits on the upstream that you have not pulled yet, **as of the last fetch**. The footer never fetches by itself, so new remote commits appear only after a fetch (for example via `/git pull`).
- `↑N` — local commits that you have not pushed yet.
- Counters refresh every 12 seconds, whenever the branch changes and right after `/git pull` or `/git branch`.
- If the branch has no upstream configured, the counters compare against the branch with the same name on a remote (preferring `origin`). If no remote has it, the branch was never pushed: `↑N` counts the commits that are not on any remote and `↓` is always `0`. A detached HEAD, or a repository without remotes, shows no counters.
- The second line keeps the usual pi stats: input/output tokens, cache reads/writes, cache hit rate, cost (with `(sub)` for subscription providers), context usage, `(auto)` when auto-compaction is enabled, and the active model.

To keep the `/git` command but leave pi's built-in footer alone, set the `PI_GIT_FOOTER` environment variable to `off` (or `0`, `false`, `no`) before starting pi:

```bash
PI_GIT_FOOTER=off pi
```

## Requirements

- [pi](https://pi.dev) (`@earendil-works/pi-coding-agent`)
- [git](https://git-scm.com/) available on your `PATH`
- Node.js `>= 22.19.0`

## Compatibility notes

- The footer is replaced through `ctx.ui.setFooter()`. If you use another extension that also customizes the footer, the one that loads last wins. Use `PI_GIT_FOOTER=off` to opt out.
- The extension API does not expose everything the built-in footer shows: the routed model of virtual models (`→ model`) and the experimental-features badge (`xp`) are not displayed.
- Commands only work inside a git working tree; elsewhere `/git` reports an error and the footer is not replaced.
- `/git pull` uses your git configuration (merge vs. rebase, credentials, etc.) as is. If git needs to prompt for credentials in the terminal, the command cannot answer and fails after the timeout; use a credential helper.
- Do not load the extension twice (for example from an npm install and from a local checkout in `~/.pi/agent/extensions/`): you would get two `/git` commands and two footers.

## Development

Clone the repository and load the extension directly into pi:

```bash
git clone https://github.com/svyaddict/pi-git-commands.git
cd pi-git-commands
pi -e ./extensions/index.ts
```

Or install your local checkout as a package (from inside the cloned directory):

```bash
pi install .
```

Pi loads TypeScript extensions directly, so no build step is needed. After editing, run `/reload` inside pi to pick up changes.

To typecheck the extension against the pi type definitions:

```bash
npm install
npm run typecheck
```

### Project structure

```text
pi-git-commands/
├── .github/workflows/
│   └── publish.yml   # Automated npm publishing on version tags
├── extensions/
│   └── index.ts      # Extension entry point
├── package.json      # npm metadata + pi manifest
├── tsconfig.json     # Typecheck-only TypeScript config
├── CHANGELOG.md
├── LICENSE
└── README.md
```

### Releasing

Releases are fully automated with GitHub Actions ([`.github/workflows/publish.yml`](.github/workflows/publish.yml)) using [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) — no npm tokens are stored in the repository, and every release ships with [provenance](https://docs.npmjs.com/generating-provenance-statements).

1. In `CHANGELOG.md`, rename the `## [Unreleased]` section to `## [x.y.z] - YYYY-MM-DD` (and update the links at the bottom), then commit it.
2. Bump the version (this creates a commit and a `vx.y.z` tag):

   ```bash
   npm version patch   # or minor / major
   ```

3. Push the commit and the tag:

   ```bash
   git push --follow-tags
   ```

The workflow then checks that the tag is on `main` and matches `package.json`, runs the typecheck, publishes the package to npm and creates a GitHub Release with the matching changelog notes. Pi shows the new changelog entries to users after they update.

## Contributing

Contributions are welcome! 🎉

1. Fork the repository.
2. Create a feature branch: `git checkout -b feat/my-feature`.
3. Commit your changes: `git commit -m "feat: add my feature"`.
4. Push the branch: `git push origin feat/my-feature`.
5. Open a Pull Request.

Found a bug or have an idea? Please [open an issue](https://github.com/svyaddict/pi-git-commands/issues).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © [svyaddict](https://github.com/svyaddict)
