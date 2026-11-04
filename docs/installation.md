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

The extension activates automatically when pi starts inside a git repository. Elsewhere `/git` reports that the directory is not a repository and the footer is not replaced.

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

- **Credentials**: `/git fetch`, `pull`, `push` and `cleanup` use your git configuration as is (merge vs. rebase, push defaults, hooks, credentials). If git needs to ask for credentials in the terminal, the command cannot answer and fails after the 120-second timeout. Use a credential helper or SSH keys.
- **Footer**: other extensions that replace the footer conflict with this one; see [Other footer extensions](footer.md#other-footer-extensions).
- **Load it once**: do not load the extension twice, for example from an npm install and from a local checkout in `~/.pi/agent/extensions/`. You would get two `/git` commands and two footers.
