import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** Ask which remote to use when there is more than one; a single remote is used as is. */
export async function pickRemote(
	ctx: ExtensionCommandContext,
	title: string,
	remotes: string[],
): Promise<string | undefined> {
	if (remotes.length === 1) {
		return remotes[0];
	}
	return ctx.ui.select(title, remotes);
}

export function notifyCancelled(ctx: ExtensionCommandContext): void {
	ctx.ui.notify("Operation cancelled.", "info");
}

export function plural(count: number, singular: string, pluralForm: string = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}
