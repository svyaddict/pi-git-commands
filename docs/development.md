# Development

## Setup

```bash
git clone https://github.com/svyaddict/pi-git-commands.git
cd pi-git-commands
npm install
```

Load your checkout into pi for one session:

```bash
pi -e ./extensions/index.ts
```

Or install it as a package (from inside the cloned directory):

```bash
pi install .
```

pi loads TypeScript directly, so there is no build step. After editing, run `/reload` inside pi to pick up the changes.

If you also have the npm package installed, remove it first so the extension is not loaded twice.

## Typecheck

```bash
npm run typecheck
```

CI runs it before every release, so make sure it passes.

## Project structure

```text
pi-git-commands/
├── extensions/
│   ├── index.ts          # Entry point: registers /git, autocomplete and footer
│   ├── git.ts            # git wrappers and repository queries
│   ├── autocomplete.ts   # /git subcommand and branch suggestions
│   ├── footer.ts         # Git-aware footer
│   ├── usage.ts          # Token/cost stats shown in the footer
│   └── commands/
│       ├── registry.ts   # Subcommand table
│       ├── shared.ts     # Helpers shared by commands
│       ├── status.ts
│       ├── fetch.ts
│       ├── pull.ts
│       ├── push.ts
│       ├── branch.ts
│       └── cleanup.ts
├── docs/                 # User and contributor documentation (not published to npm)
├── .github/workflows/
│   └── publish.yml       # npm publishing on version tags
├── package.json          # npm metadata + pi manifest
└── tsconfig.json         # Typecheck-only TypeScript config
```

Only `extensions/index.ts` is declared in the `pi` manifest of `package.json`; the other files are modules it imports. Imports between them use the `.ts` extension (`import { runGit } from "./git.ts"`).

### Where things go

| You want to… | Edit |
|---|---|
| run a new git query or change how one is parsed | `git.ts` |
| add or change a `/git` subcommand | `commands/<name>.ts` + `commands/registry.ts` |
| change suggestions | `autocomplete.ts` |
| change what the footer shows | `footer.ts` (layout) or `usage.ts` (token/cost stats) |

## Adding a command

1. **Write the handler** in `extensions/commands/<name>.ts`:

   ```ts
   import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
   import { describeFailure, runGit } from "../git.ts";

   export async function handleGitLog(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
   	const result = await runGit(pi, ctx.cwd, ["log", "--oneline", "-10"]);
   	if (result.code !== 0) {
   		ctx.ui.notify(`git log failed: ${describeFailure(result)}`, "error");
   		return;
   	}
   	ctx.ui.notify(result.stdout.trim(), "info");
   }
   ```

2. **Register it** in `extensions/commands/registry.ts` by adding an entry to `SUBCOMMANDS`:

   ```ts
   {
   	name: "log",
   	usage: "log",
   	description: "Show the last 10 commits",
   	takesArgument: false,
   	run: (pi, ctx) => handleGitLog(pi, ctx),
   },
   ```

   That single entry gives you dispatch, the usage text, autocomplete and the footer refresh after the command.

3. **Document it**: a row in the README command table, a section in [commands.md](commands.md) and an entry in `CHANGELOG.md` under `[Unreleased]`.

### Conventions

- Run git through `runGit()`. Pass `GIT_NETWORK_TIMEOUT_MS` for anything that contacts a remote.
- Never let git prompt: commands run without a terminal. Ask the user with `ctx.ui.confirm()` / `ctx.ui.select()` before anything destructive or that publishes (push, delete, force).
- Report the result with a single `ctx.ui.notify()`, and use `describeFailure()` for errors so timeouts read as timeouts.
- Validate user input before passing it to git (see `validateBranchName()`).
- Use `notifyCancelled()` when the user declines a prompt.

## Testing

There is no automated test suite yet. Before opening a PR, try the commands you touched in a scratch repository with a local bare remote:

```bash
git init --bare -b main remote.git
git clone remote.git repo
cd repo
pi -e /path/to/pi-git-commands/extensions/index.ts
```

Useful cases to check: branch without upstream, branch never pushed, detached HEAD, a remote with new commits, a remote-deleted branch.

## Releasing

Releases are automated with GitHub Actions ([`publish.yml`](../.github/workflows/publish.yml)) using [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): no npm tokens are stored in the repository, and every release ships with [provenance](https://docs.npmjs.com/generating-provenance-statements).

1. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD` (and update the links at the bottom), then commit.
2. Bump the version; this creates a commit and a `vx.y.z` tag:

   ```bash
   npm version patch   # or minor / major
   ```

3. Push the commit and the tag:

   ```bash
   git push --follow-tags
   ```

The workflow checks that the tag is on `main` and matches `package.json`, runs the typecheck, publishes to npm and creates a GitHub Release with the changelog notes.
