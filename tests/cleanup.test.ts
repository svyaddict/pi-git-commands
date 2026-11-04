import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LocalBranch } from "../extensions/commands/cleanup.ts";
import { parseLocalBranches, selectCleanupCandidates } from "../extensions/commands/cleanup.ts";

const BASE_OID = "b".repeat(40);

const branch = (name: string, fields: Partial<LocalBranch> = {}): LocalBranch => ({
	name,
	oid: "a".repeat(40),
	upstream: `origin/${name}`,
	track: "",
	worktree: "",
	...fields,
});

const select = (branches: LocalBranch[], merged: string[], extra: { current?: string; base?: string } = {}) =>
	selectCleanupCandidates({
		branches,
		merged: new Set(merged),
		base: "origin/main",
		baseOid: BASE_OID,
		current: "main",
		...extra,
	}).map((c) => `${c.name}: ${c.reasons.join(", ")}`);

describe("cleanup candidate selection", () => {
	it("offers branches whose upstream is gone, merged or not", () => {
		assert.deepEqual(select([branch("feat", { track: "[gone]" })], []), ["feat: upstream deleted"]);
		assert.deepEqual(select([branch("feat", { track: "[gone]" })], ["feat"]), [
			"feat: upstream deleted, merged into origin/main",
		]);
	});

	it("offers published branches merged into the base", () => {
		assert.deepEqual(select([branch("feat")], ["feat"]), ["feat: merged into origin/main"]);
	});

	it("never offers a branch just created from the base", () => {
		assert.deepEqual(select([branch("new-work", { oid: BASE_OID })], ["new-work"]), []);
		assert.deepEqual(select([branch("new-work", { oid: BASE_OID, upstream: "" })], ["new-work"]), []);
	});

	it("never offers merged branches that were never pushed", () => {
		assert.deepEqual(select([branch("local", { upstream: "" })], ["local"]), []);
	});

	it("never offers protected, current, base or worktree branches", () => {
		const branches = [
			branch("main", { track: "[gone]" }),
			branch("develop"),
			branch("current", { track: "[gone]" }),
			branch("in-worktree", { track: "[gone]", worktree: "/elsewhere" }),
		];
		assert.deepEqual(select(branches, ["main", "develop", "current", "in-worktree"], { current: "current" }), []);
	});

	it("protects the base even when it is not a usual name", () => {
		assert.deepEqual(select([branch("trunk")], ["trunk"], { base: "origin/trunk" }), []);
	});

	it("ignores the merged state without a base", () => {
		const candidates = selectCleanupCandidates({ branches: [branch("feat")], merged: new Set(["feat"]) });
		assert.deepEqual(candidates, []);
	});

	it("sorts candidates by name", () => {
		const branches = [branch("zeta", { track: "[gone]" }), branch("alpha", { track: "[gone]" })];
		assert.deepEqual(select(branches, []), ["alpha: upstream deleted", "zeta: upstream deleted"]);
	});

	it("parses for-each-ref output with NUL separators", () => {
		const parsed = parseLocalBranches(`feat\0abc\0origin/feat\0[gone]\0\nmain\0def\0origin/main\0\0/repo\n`);
		assert.deepEqual(parsed, [
			{ name: "feat", oid: "abc", upstream: "origin/feat", track: "[gone]", worktree: "" },
			{ name: "main", oid: "def", upstream: "origin/main", track: "", worktree: "/repo" },
		]);
	});
});
