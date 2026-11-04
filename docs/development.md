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

## Checks

```bash
npm run check       # everything below, in order
npm run lint        # Biome: lint + formatting + import order
npm run format      # apply Biome fixes
npm run typecheck   # tsc, no emit
npm test            # node:test, unit + integration
```

CI ([`ci.yml`](../.github/workflows/ci.yml)) runs lint and typecheck, then the tests on Linux, Windows and macOS with Node 22.19 (the minimum) and 24, on every push to `main` and every pull request. Releases run the same workflow before publishing.

## Project structure

```text
pi-git-commands/
├── extensions/
│   ├── index.ts          # Entry point: registers /git, autocomplete and footer
│   ├── git.ts            # git wrappers and repository queries
│   ├── autocomplete.ts   # /git subcommand and branch suggestions
│   ├── footer.ts         # Git-aware footer and its on/off controller
│   ├── settings.ts       # User preferences in <agent-dir>/pi-git-commands.json
│   ├── usage.ts          # Token/cost stats shown in the footer
│   └── commands/
│       ├── registry.ts   # Subcommand table
│       ├── shared.ts     # Helpers shared by commands
│       ├── status.ts
│       ├── fetch.ts
│       ├── pull.ts
│       ├── push.ts
│       ├── branch.ts
│       ├── cleanup.ts
│       └── footer.ts     # /git footer [on|off]
├── tests/
│   ├── helpers.ts        # Isolated git sandbox, repo fixtures, fake command context
│   ├── *.test.ts         # Unit tests (parsers, messages, candidate selection, autocomplete)
│   └── integration.test.ts # Commands run against real repositories with a local bare remote
├── docs/                 # User and contributor documentation (not published to npm)
├── .github/workflows/
│   ├── ci.yml            # Lint, typecheck and tests on push and pull requests
│   └── publish.yml       # npm publishing on version tags
├── biome.json            # Lint and format configuration
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
| add a user preference | `settings.ts` (saved for every session; never use environment variables for this) |

## Adding a command

1. **Write the handler** in `extensions/commands/<name>.ts`:

   ```ts
   import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
   import { describeFailure, runGit } from "../git.ts";

   export async function handleGitLog(ctx: ExtensionCommandContext): Promise<void> {
   	const result = await runGit(ctx.cwd, ["log", "--oneline", "-10"]);
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
   	run: (ctx) => handleGitLog(ctx),
   },
   ```

   That single entry gives you dispatch, the usage text, autocomplete and the footer refresh after the command.

3. **Test it**: pure parsing/formatting goes in a unit test; behavior against git goes in `tests/integration.test.ts` using `createFixture()` and `fakeContext()` (see below).

4. **Document it**: a row in the README command table, a section in [commands.md](commands.md) and an entry in `CHANGELOG.md` under `[Unreleased]`.

### Conventions

- Run git through `runGit()`, never `pi.exec()` or `child_process` directly. `runGit()` makes git non-interactive (`GIT_TERMINAL_PROMPT=0`, no Credential Manager window, no controlling terminal on POSIX), fixes the message language with `LC_ALL=C`, and on timeout terminates git with all its child processes. Pass `GIT_NETWORK_TIMEOUT_MS` for anything that contacts a remote.
- Keep parsing and decisions in pure, exported functions (`parseStatus()`, `selectCleanupCandidates()`, …) so they can be unit-tested without git.
- A query returns "none" (`undefined`, `false`, an empty list) only when git says so: no upstream, detached HEAD, missing ref. Any other failure, including a timeout, throws `GitError` (use `queryGit()`); the `/git` dispatcher turns it into an error notification. Commands act on these answers, so a failed query must never look like missing data. Background features (footer counters, autocomplete) catch the error and show nothing instead.
- Commands run without a terminal. Ask the user with `ctx.ui.confirm()` / `ctx.ui.select()` before anything destructive or that publishes (push, delete, force).
- Report the result with a single `ctx.ui.notify()`, and use `describeFailure()` for errors so timeouts read as timeouts.
- Validate user input before passing it to git (see `validateBranchName()`).
- Use `notifyCancelled()` when the user declines a prompt.

## Testing

Tests use the built-in `node:test` runner; Node runs the TypeScript files directly.

- `tests/helpers.ts` points git at an empty global config and disables the system one, so the tests do not depend on your credential helpers, signing or aliases. Import it (directly or through another helper) in any test that runs git.
- `createFixture()` creates a bare `origin` with one commit and a clone of it; `cloneAnother()` gives a second working copy to simulate someone else pushing.
- `fakeContext(cwd, answers)` records notifications and answers `confirm()` / `select()` in order. An unexpected prompt fails the test.
- Integration suites run their tests concurrently; every test builds its own fixture. Test helpers are asynchronous: never use synchronous `child_process` calls in tests, because they block the event loop and make other tests' git commands look like they timed out.

A test should fail if the behavior it protects is removed. A quick way to check: break the code on purpose and run the test.

To try a change by hand, use a scratch repository with a local bare remote:

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

The workflow checks that the tag is on `main` and matches `package.json`, runs the full CI (lint, typecheck and tests), publishes to npm and creates a GitHub Release with the changelog notes.
