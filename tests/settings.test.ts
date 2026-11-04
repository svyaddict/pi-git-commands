import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	DEFAULT_SETTINGS,
	readSettings,
	readSettingsOrDefaults,
	SettingsError,
	updateSettings,
} from "../extensions/settings.ts";
import { tempDir } from "./helpers.ts";

const settingsFile = (content?: string) => {
	const path = join(tempDir(), "pi-git-commands.json");
	if (content !== undefined) {
		writeFileSync(path, content);
	}
	return path;
};

describe("settings file", () => {
	it("defaults to the footer being on", async () => {
		assert.deepEqual(DEFAULT_SETTINGS, { footer: true });
		assert.deepEqual(await readSettings(settingsFile()), { footer: true });
		assert.deepEqual(await readSettings(settingsFile("{}")), { footer: true });
		assert.deepEqual(await readSettings(settingsFile('{ "footer": "no" }')), { footer: true });
		assert.deepEqual(await readSettings(settingsFile('{ "footer": false }')), { footer: false });
	});

	it("reports invalid files, but startup falls back to the defaults", async () => {
		for (const content of ["{ broken", "[]", "null", "42"]) {
			const path = settingsFile(content);
			await assert.rejects(readSettings(path), SettingsError, content);
			assert.deepEqual(await readSettingsOrDefaults(path), { footer: true }, content);
		}
	});

	it("creates the file and its directory, keeping unknown keys on later updates", async () => {
		const path = join(tempDir(), "nested", "dir", "pi-git-commands.json");
		assert.deepEqual(await updateSettings(path, { footer: false }), { footer: false });
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { footer: false });

		writeFileSync(path, JSON.stringify({ footer: false, future: { a: 1 } }));
		await updateSettings(path, { footer: true });
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { footer: true, future: { a: 1 } });
	});

	it("never overwrites an invalid file and leaves no temporary file behind", async () => {
		const path = settingsFile("{ broken");
		await assert.rejects(updateSettings(path, { footer: false }), SettingsError);
		assert.equal(readFileSync(path, "utf8"), "{ broken");

		const ok = settingsFile("{}");
		await updateSettings(ok, { footer: false });
		assert.deepEqual(readdirSync(join(ok, "..")), ["pi-git-commands.json"]);
	});
});
