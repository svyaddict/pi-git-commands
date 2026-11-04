# Contributing

Thanks for helping improve pi-git-commands! 🎉

## Reporting a bug or asking for a feature

[Open an issue](https://github.com/svyaddict/pi-git-commands/issues). For bugs, include:

- the command you ran and the message pi showed;
- your OS, git version (`git --version`) and pi version;
- the repository state if it matters (detached HEAD, branch without upstream, several remotes, …).

## Submitting a change

1. Fork the repository and create a branch: `git switch -c feat/my-feature`.
2. Make your change. [docs/development.md](docs/development.md) explains the project layout, how to load your checkout into pi and how to add a command.
3. Run `npm run typecheck`.
4. Update the docs: the README command table and [docs/commands.md](docs/commands.md) if behavior changes, plus an entry under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
5. Commit using [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, …) and open a pull request.

Keep pull requests focused: one feature or fix per PR is much easier to review.
