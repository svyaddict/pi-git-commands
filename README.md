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

- 🔄 **`/git pull`** — `git fetch --prune` + `git pull` in a single command.
- 🌿 **`/git branch`** — list local branches, highlighting the current one and branches that exist only locally.
- 🔀 **`/git branch <name>`** — switch to a branch, or create it (with confirmation) if it does not exist yet.
- ⌨️ **Autocomplete** — subcommands and local branch names are suggested as you type.
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

Runs `git fetch --prune` followed by `git pull` in the current working directory and reports the result as a notification.

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

- If the branch exists locally, pi checks it out.
- If it does not exist, pi asks for confirmation and then creates it from the current branch (`git checkout -b`).

### Autocomplete

- Typing `/git ` suggests the available subcommands (`pull`, `branch`).
- Typing `/git branch ` suggests local branches, annotated as *current branch*, *local only* or *present on remote*.

### Git-aware footer

In interactive (TUI) mode the footer shows:

```text
~/projects/my-app (main ↓2 ↑1) • my-session
↑12k ↓3.4k R45k W8k CH78.3% $0.123 21.4%/200k (auto)        (anthropic) claude-sonnet • medium
```

- `↓N` — commits on the upstream that you have not pulled yet.
- `↑N` — local commits that you have not pushed yet.
- Counters refresh every 12 seconds and whenever the branch changes. Branches without an upstream show `↓0 ↑0`.
- The second line keeps the usual pi stats: input/output tokens, cache reads/writes, cache hit rate, cost, context usage and the active model.

## Requirements

- [pi](https://pi.dev) (`@earendil-works/pi-coding-agent`)
- [git](https://git-scm.com/) available on your `PATH`
- Node.js `>= 22.19.0`

## Compatibility notes

- The footer is replaced through `ctx.ui.setFooter()`. If you use another extension that also customizes the footer, the one that loads last wins.
- Commands only work inside a git working tree; elsewhere `/git` reports an error and the footer is not replaced.
- `/git pull` uses your git configuration (merge vs. rebase, credentials, etc.) as is.

## Development

Clone the repository and load the extension directly into pi:

```bash
git clone https://github.com/svyaddict/pi-git-commands.git
cd pi-git-commands
pi -e ./extensions/index.ts
```

Or install your local checkout as a package:

```bash
pi install ./pi-git-commands
```

Pi loads TypeScript extensions directly, so no build step is needed. After editing, run `/reload` inside pi to pick up changes.

### Project structure

```text
pi-git-commands/
├── .github/workflows/
│   └── publish.yml   # Automated npm publishing on version tags
├── extensions/
│   └── index.ts      # Extension entry point
├── package.json      # npm metadata + pi manifest
├── CHANGELOG.md
├── LICENSE
└── README.md
```

### Releasing

Releases are fully automated with GitHub Actions ([`.github/workflows/publish.yml`](.github/workflows/publish.yml)) using [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) — no npm tokens are stored in the repository, and every release ships with [provenance](https://docs.npmjs.com/generating-provenance-statements).

1. Add a new `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md` and commit it.
2. Bump the version (this creates a commit and a `vx.y.z` tag):

   ```bash
   npm version patch   # or minor / major
   ```

3. Push the commit and the tag:

   ```bash
   git push --follow-tags
   ```

The workflow then checks that the tag is on `main` and matches `package.json`, publishes the package to npm and creates a GitHub Release with the matching changelog notes. Pi shows the new changelog entries to users after they update.

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
