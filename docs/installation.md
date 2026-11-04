# Installation

## Requirements

- [pi](https://pi.dev) (`@earendil-works/pi-coding-agent`)
- [git](https://git-scm.com/) available on your `PATH`
- Node.js `>= 22.19.0`

## Install

From npm (recommended):

```bash
pi install npm:@svyaddict/pi-git-commands
```

From GitHub:

```bash
pi install git:github.com/svyaddict/pi-git-commands
```

For the current project only (written to `.pi/settings.json`):

```bash
pi install -l npm:@svyaddict/pi-git-commands
```

For a single session, without installing:

```bash
pi -e npm:@svyaddict/pi-git-commands
```

The extension activates automatically when pi starts inside a git repository. Elsewhere `/git` reports that the directory is not a repository. The [git-aware footer](footer.md) is on by default; `/git footer off` turns it off for every pi session.

## Update

```bash
pi update npm:@svyaddict/pi-git-commands
```

`pi update --extensions` updates all installed packages at once. pi shows the new [changelog](../CHANGELOG.md) entries after an update.

## Remove

```bash
pi remove npm:@svyaddict/pi-git-commands
```

## Compatibility notes

- **Credentials**: `/git fetch`, `pull`, `push` and `cleanup` use your git configuration (push defaults, hooks, credential helpers). git never prompts: if credentials are missing, the command fails right away with git's error instead of waiting for input. Use a credential helper that already has your credentials, or SSH keys loaded in an agent. On Windows, the Git Credential Manager is told not to open its sign-in window; sign in once from a terminal first.
- **Pull strategy**: `/git pull` only fast-forwards; it never creates merge commits or rebases, whatever `pull.rebase` says. See [`/git pull`](commands.md#git-pull).
- **Messages**: git runs with `LC_ALL=C`, so its messages are in English even if your system is localized (the extension recognizes some of them).
- **Footer**: when enabled, it conflicts with other extensions that replace the footer; see [Other footer extensions](footer.md#other-footer-extensions).
- **pi version**: developed and tested against pi 1.5. The footer reproduces pi's built-in one with internal APIs, so a future pi release may change what it can show.
- **Load it once**: do not load the extension twice, for example from an npm install and from a local checkout in `~/.pi/agent/extensions/`. You would get two `/git` commands (and two footers, if enabled).
