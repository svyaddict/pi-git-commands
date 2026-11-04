import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * User preferences of the extension, shared by every pi instance and terminal. They live next
 * to pi's own configuration, in `<agent-dir>/pi-git-commands.json` (`~/.pi/agent` by default).
 */
export type GitCommandsSettings = {
	/** Show the git-aware footer. On unless turned off. */
	footer: boolean;
};

export const DEFAULT_SETTINGS: Readonly<GitCommandsSettings> = { footer: true };

export const SETTINGS_FILE_NAME = "pi-git-commands.json";

export function defaultSettingsPath(): string {
	return join(getAgentDir(), SETTINGS_FILE_NAME);
}

export class SettingsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SettingsError";
	}
}

/** Raw file content as an object; undefined when the file does not exist. */
async function readObject(path: string): Promise<Record<string, unknown> | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw new SettingsError(`Cannot read ${path}: ${(error as Error).message}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new SettingsError(`${path} is not valid JSON. Fix or delete it.`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new SettingsError(`${path} must contain a JSON object. Fix or delete it.`);
	}
	return value as Record<string, unknown>;
}

function normalize(raw: Record<string, unknown> | undefined): GitCommandsSettings {
	return {
		footer: typeof raw?.footer === "boolean" ? raw.footer : DEFAULT_SETTINGS.footer,
	};
}

/** Read the settings; a missing file or missing keys mean the defaults. Throws {@link SettingsError}. */
export async function readSettings(path: string): Promise<GitCommandsSettings> {
	return normalize(await readObject(path));
}

/**
 * For startup: never fails. An unreadable file falls back to the defaults; `/git footer`
 * reports the problem when the user looks at or changes the setting.
 */
export async function readSettingsOrDefaults(path: string): Promise<GitCommandsSettings> {
	try {
		return await readSettings(path);
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

/**
 * Update some settings and save them. Keys the extension does not know are kept, and the file
 * is replaced atomically, so another pi instance never reads a half-written file. An invalid
 * file is reported instead of being overwritten, since the user may have edited it by hand.
 */
export async function updateSettings(
	path: string,
	changes: Partial<GitCommandsSettings>,
): Promise<GitCommandsSettings> {
	const raw = (await readObject(path)) ?? {};
	const next = { ...raw, ...changes };
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(next, null, "\t")}\n`, "utf8");
	await rename(temporary, path);
	return normalize(next);
}
