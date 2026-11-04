import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AheadBehind } from "../git.ts";
import { describeFailure, getAheadBehind, runGit } from "../git.ts";

const MAX_ENTRIES_PER_SECTION = 15;

type StatusEntry = {
	/** One- or two-letter git status code, e.g. "M", "A", "UU". */
	code: string;
	path: string;
};

type WorkingTreeStatus = {
	branch?: string;
	/** Abbreviated commit id, used to describe a detached HEAD. */
	oid?: string;
	upstream?: string;
	staged: StatusEntry[];
	unstaged: StatusEntry[];
	untracked: string[];
	conflicts: StatusEntry[];
};

/** Everything after the first `count` space-separated fields (paths may contain spaces). */
function fieldsFrom(entry: string, count: number): string {
	return entry.split(" ").slice(count).join(" ");
}

/**
 * Parse `git status --porcelain=v2 --branch -z`. With -z paths are NUL-terminated and never
 * quoted; a rename entry is followed by an extra NUL-terminated field with the original path.
 */
export function parseStatus(output: string): WorkingTreeStatus {
	const status: WorkingTreeStatus = { staged: [], unstaged: [], untracked: [], conflicts: [] };
	const entries = output.split("\0");

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) {
			continue;
		}

		if (entry.startsWith("# branch.head ")) {
			const head = entry.slice("# branch.head ".length);
			status.branch = head === "(detached)" ? undefined : head;
		} else if (entry.startsWith("# branch.oid ")) {
			status.oid = entry.slice("# branch.oid ".length, "# branch.oid ".length + 7);
		} else if (entry.startsWith("# branch.upstream ")) {
			status.upstream = entry.slice("# branch.upstream ".length);
		} else if (entry.startsWith("1 ") || entry.startsWith("2 ")) {
			const isRename = entry.startsWith("2 ");
			const [x, y] = entry.slice(2, 4);
			const path = fieldsFrom(entry, isRename ? 9 : 8);
			const original = isRename ? entries[++i] : undefined;
			if (x !== ".") {
				// The rename is staged; unstaged changes only concern the new path.
				status.staged.push({ code: x, path: original ? `${original} → ${path}` : path });
			}
			if (y !== ".") {
				status.unstaged.push({ code: y, path });
			}
		} else if (entry.startsWith("u ")) {
			status.conflicts.push({ code: entry.slice(2, 4), path: fieldsFrom(entry, 10) });
		} else if (entry.startsWith("? ")) {
			status.untracked.push(entry.slice(2));
		}
	}

	return status;
}

function formatSection(title: string, lines: string[]): string[] {
	if (lines.length === 0) {
		return [];
	}
	const shown = lines.slice(0, MAX_ENTRIES_PER_SECTION).map((x) => `  ${x}`);
	if (lines.length > MAX_ENTRIES_PER_SECTION) {
		shown.push(`  … and ${lines.length - MAX_ENTRIES_PER_SECTION} more`);
	}
	return [`${title} (${lines.length}):`, ...shown];
}

function formatHeader(status: WorkingTreeStatus, sync: AheadBehind): string {
	if (!status.branch) {
		return `HEAD detached at ${status.oid ?? "unknown commit"}`;
	}
	const upstreamPart = status.upstream ? ` → ${status.upstream}` : " (no upstream)";
	const syncPart = sync.available ? ` ↓${sync.incoming} ↑${sync.outgoing}` : "";
	return `On branch ${status.branch}${upstreamPart}${syncPart}`;
}

export function formatStatus(status: WorkingTreeStatus, sync: AheadBehind): string {
	const withCode = (entries: StatusEntry[]) => entries.map((e) => `${e.code.padEnd(2)} ${e.path}`);
	const sections = [
		...formatSection("Conflicts", withCode(status.conflicts)),
		...formatSection("Staged", withCode(status.staged)),
		...formatSection("Not staged", withCode(status.unstaged)),
		...formatSection("Untracked", status.untracked),
	];
	const body = sections.length > 0 ? sections : ["Working tree clean."];
	return [formatHeader(status, sync), ...body].join("\n");
}

export async function handleGitStatus(ctx: ExtensionCommandContext): Promise<void> {
	const [statusResult, sync] = await Promise.all([
		runGit(ctx.cwd, ["status", "--porcelain=v2", "--branch", "-z"]),
		getAheadBehind(ctx.cwd),
	]);
	if (statusResult.code !== 0) {
		ctx.ui.notify(`git status failed: ${describeFailure(statusResult)}`, "error");
		return;
	}

	ctx.ui.notify(formatStatus(parseStatus(statusResult.stdout), sync), "info");
}
