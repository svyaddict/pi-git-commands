# Commands

All commands are subcommands of `/git` and work only inside a git working tree. Commands that talk to a remote (`fetch`, `pull`, `push`, `cleanup`) time out after 120 seconds; the others after 20 seconds. After every command the [footer](footer.md) counters refresh right away.

| Command | What it does |
|---|---|
| [`/git status`](#git-status) | Summary of conflicts, staged, unstaged and untracked files |
| [`/git fetch`](#git-fetch) | Fetch all remotes, prune stale branches, report incoming commits |
| [`/git pull`](#git-pull) | Pull the current branch, setting its upstream if needed |
| [`/git push`](#git-push) | Push the current branch, setting its upstream if needed |
| [`/git branch [name]`](#git-branch) | List branches, or switch to / check out / create one |
| [`/git cleanup`](#git-cleanup) | Delete merged branches and branches whose upstream is gone |

Running `/git` with no subcommand shows the usage line. Subcommands that take no argument reject one (`/git pull origin` is an error, not a silent `/git pull`).

## Contents

- [`/git status`](#git-status)
- [`/git fetch`](#git-fetch)
- [`/git pull`](#git-pull)
- [`/git push`](#git-push)
- [`/git branch`](#git-branch)
- [`/git cleanup`](#git-cleanup)
- [Autocomplete](#autocomplete)

## `/git status`

```text
/git status
```

```text
On branch feature/login → origin/feature/login ↓0 ↑2
Staged (2):
  M  src/auth.ts
  R  old.ts → new.ts
Not staged (1):
  M  README.md
Untracked (1):
  notes.txt
```

- The header shows the branch, its upstream (or `(no upstream)`) and the same `↓incoming ↑outgoing` counters as the footer. On a detached HEAD it shows `HEAD detached at <commit>`.
- Sections appear only when they have entries, in this order: **Conflicts**, **Staged**, **Not staged**, **Untracked**. Each lists at most 15 files, followed by `… and N more`.
- Each file is prefixed with git's one-letter status code: `M` modified, `A` added, `D` deleted, `R` renamed, `C` copied, `T` type changed. Conflicts use git's two-letter codes (`UU`, `AA`, …).
- A clean tree shows `Working tree clean.`

File names with spaces or non-ASCII characters are shown as they are, not quoted.

## `/git fetch`

```text
/git fetch
```

```text
git fetch completed. Pruned 2 stale remote-tracking branches. 'main' is 3 commits behind: run /git pull to update.
```

Updates every remote and removes remote-tracking branches that were deleted on the remote. The notification reports:

- how many stale remote-tracking branches were pruned, if any;
- whether the current branch has incoming commits.

Use it to refresh the footer's `↓` counter without changing your working tree.

## `/git pull`

```text
/git pull
```

Pulls the current branch and prunes stale remote-tracking branches in one step. Merge or rebase follows your git configuration (`pull.rebase`, `branch.<name>.rebase`). The result is reported as a short notification.

If the current branch has no upstream:

- **a same-named branch exists on a remote**: pi offers to set it as upstream and then pulls. If several remotes have it, pi asks which one.
- **no remote has it**: pi explains there is nothing to pull and suggests [`/git push`](#git-push).

On a detached HEAD, pull is refused.

## `/git push`

```text
/git push
```

- **The branch has an upstream**: pi runs a plain `git push`, following your git configuration (`push.default`, credentials, hooks).
- **The branch has no upstream**: pi chooses where to push:
  1. a remote that already has a branch with the same name, otherwise
  2. any remote, `origin` first.

  If there is more than one choice, pi asks. Then it asks for confirmation and pushes with `--set-upstream`, so later pushes and pulls work without arguments.

Outcomes:

| Situation | Message |
|---|---|
| Commits pushed | `Pushed 'feature/x' to 'origin/feature/x'.` |
| Nothing new | `Nothing to push: 'feature/x' is up to date with 'origin/feature/x'.` |
| Remote has commits you don't have | `the remote has commits that you do not have locally. Run /git pull first, then push again.` |
| Rejected by the server (protected branch, hook) | git's error, without the long hints |
| No remotes configured | Suggests adding one with `git remote add` |

pi never force-pushes.

## `/git branch`

### List branches

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

### Switch, check out or create

```text
/git branch feature/login
```

1. **The branch exists locally**: pi switches to it.
2. **It exists only on a remote**: pi creates a local branch that tracks it. If several remotes have it, pi asks which one.
3. **Otherwise**: pi asks for confirmation and creates it from the current branch.

The name is validated first, so invalid names (with spaces, starting with `-`, containing `..`, …) are rejected. Git shorthands work too: `@{-1}` is the previously checked-out branch.

If the switch fails, for example because uncommitted changes would be overwritten, pi shows git's error and leaves everything as it was.

## `/git cleanup`

```text
/git cleanup
```

```text
Local branches that can be deleted:
  feature/login (upstream deleted)
  fix/typo (merged into origin/main)
```

Deletes local branches you no longer need. pi first fetches all remotes with pruning, so branches deleted on the remote are detected. If the fetch fails (for example offline), pi warns and continues with local data. It then offers:

- branches whose **upstream was deleted** on the remote, typically after a PR is merged and its branch removed;
- branches already **merged into the default branch**: `origin/HEAD`, otherwise `main` or `master`.

**Never offered**: the current branch, the default branch, and `main`, `master`, `develop`, `dev`.

**Choosing**: with a single candidate pi asks for confirmation. With several, you can delete them all, choose one by one, or cancel.

**Squash and rebase merges**: branches merged this way look unmerged to git, so a normal delete refuses them. pi lists them and asks before force-deleting them. If you decline, they are kept.

**Undo**: the summary shows the commit each deleted branch pointed to:

```text
Deleted 2 branches:
  feature/login (was 3325c16)
  fix/typo (was 5cb51ea)
```

To restore one: `git branch feature/login 3325c16`.

## Autocomplete

- Typing `/git ` suggests the subcommands with a short description.
- Typing `/git branch ` suggests branches:
  - local branches, annotated as *current branch*, *local only* or *present on remote*;
  - then branches that exist only on a remote, annotated as *remote only (origin)*.

Suggestions filter as you type, and selecting `branch` leads straight into branch suggestions.
