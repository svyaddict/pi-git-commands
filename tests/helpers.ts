import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CommandServices } from "../extensions/commands/registry.ts";
import { createFooterController } from "../extensions/footer.ts";

/*
 * Isolate every git process started by the tests (including the extension's own runGit, which
 * inherits process.env) from the user's system and global configuration: credential helpers,
 * signing, aliases, hooks paths or a different default branch would make results depend on
 * the machine.
 */
const sandbox = mkdtempSync(join(tmpdir(), "pi-git-commands-test-"));
const globalConfig = join(sandbox, "gitconfig");
writeFileSync(
	globalConfig,
	["[init]", "\tdefaultBranch = main", "[commit]", "\tgpgsign = false", "[advice]", "\tdetachedHead = false", ""].join(
		"\n",
	),
);
Object.assign(process.env, {
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: globalConfig,
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
});

process.on("exit", () => {
	rmSync(sandbox, { recursive: true, force: true });
});

const execFileAsync = promisify(execFile);

/**
 * Run git for test setup; rejects on failure. Asynchronous on purpose: tests run concurrently,
 * and a synchronous call would block the event loop, so other tests could not see their git
 * processes exit and their timeouts would fire on commands that had long finished.
 */
export async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
	return stdout.trim();
}

let counter = 0;

export function tempDir(): string {
	const dir = join(sandbox, `case-${++counter}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export async function commit(
	cwd: string,
	file: string,
	content: string = file,
	message: string = `add ${file}`,
): Promise<string> {
	writeFileSync(join(cwd, file), content);
	await git(cwd, "add", file);
	await git(cwd, "commit", "-q", "-m", message);
	return git(cwd, "rev-parse", "HEAD");
}

export type Fixture = {
	/** Bare repository acting as `origin`. */
	remote: string;
	/** Working clone used by the extension. */
	repo: string;
	/** Clone a second working copy of the remote, e.g. to push commits "from someone else". */
	cloneAnother(): Promise<string>;
};

/** A bare `origin` with one commit on main, and a clone tracking it. */
export async function createFixture(): Promise<Fixture> {
	const root = tempDir();
	const remote = join(root, "remote.git");
	const repo = join(root, "repo");
	await git(root, "init", "-q", "--bare", "-b", "main", remote);
	await git(root, "clone", "-q", remote, repo);
	await commit(repo, "README.md", "hello\n", "initial");
	await git(repo, "push", "-q", "-u", "origin", "main");
	// Like a real clone of a non-empty repository: origin/HEAD points at the default branch.
	await git(repo, "remote", "set-head", "origin", "main");

	let clones = 0;
	return {
		remote,
		repo,
		async cloneAnother() {
			const dir = join(root, `other-${++clones}`);
			await git(root, "clone", "-q", remote, dir);
			return dir;
		},
	};
}

export type Notification = { message: string; level: string };

export type FakeContext = {
	ctx: ExtensionCommandContext;
	notifications: Notification[];
	/** Prompts shown to the user, in order. */
	prompts: string[];
	/** The last notification's message. */
	lastMessage(): string;
	/** Arguments of every ctx.ui.setFooter() call: a factory to show a footer, undefined to restore pi's. */
	footerCalls: unknown[];
};

export type FakeContextOptions = {
	answers?: Array<boolean | string | undefined>;
	/** pi's run mode; the git footer is only shown in "tui". */
	mode?: "tui" | "rpc" | "json" | "print";
};

/**
 * Minimal command context. `answers` are consumed in order by confirm() (booleans) and
 * select() (strings or undefined); running out of answers fails the test.
 */
export function fakeContext(
	cwd: string,
	answersOrOptions: Array<boolean | string | undefined> | FakeContextOptions = [],
): FakeContext {
	const options = Array.isArray(answersOrOptions) ? { answers: answersOrOptions } : answersOrOptions;
	const notifications: Notification[] = [];
	const prompts: string[] = [];
	const footerCalls: unknown[] = [];
	const queue = [...(options.answers ?? [])];
	const next = (prompt: string) => {
		prompts.push(prompt);
		if (queue.length === 0) {
			throw new Error(`Unexpected prompt: ${prompt}`);
		}
		return queue.shift();
	};

	const ui = {
		setFooter(factory: unknown) {
			footerCalls.push(factory);
		},
		notify(message: string, level = "info") {
			notifications.push({ message, level });
		},
		async confirm(title: string, message: string) {
			const answer = next(`${title}: ${message}`);
			if (typeof answer !== "boolean") {
				throw new Error(`Expected a boolean answer for confirm, got ${String(answer)}`);
			}
			return answer;
		},
		async select(title: string, options: string[]) {
			const answer = next(`${title}: ${options.join(" | ")}`);
			if (answer !== undefined && (typeof answer !== "string" || !options.includes(answer))) {
				throw new Error(`Answer ${String(answer)} is not one of: ${options.join(", ")}`);
			}
			return answer;
		},
	};

	return {
		ctx: { cwd, ui, mode: options.mode ?? "tui" } as unknown as ExtensionCommandContext,
		notifications,
		prompts,
		lastMessage: () => notifications.at(-1)?.message ?? "",
		footerCalls,
	};
}

/** Services for runGitCommand() with a real footer controller on a throwaway settings file. */
export function testServices(settingsPath: string = join(tempDir(), "settings.json")) {
	const footer = createFooterController(settingsPath);
	let refreshes = 0;
	const services: CommandServices = {
		footer: {
			...footer,
			refresh() {
				refreshes++;
				footer.refresh();
			},
		},
	};
	return { services, settingsPath, refreshes: () => refreshes };
}
