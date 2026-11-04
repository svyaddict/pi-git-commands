import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { FooterController, FooterStatus } from "../footer.ts";
import { SettingsError } from "../settings.ts";

export const FOOTER_USAGE = "Usage: /git footer [on|off]";

function describeStatus(status: FooterStatus): string {
	if (!status.enabled) {
		return "Git footer: off. pi's built-in footer is used.";
	}
	return status.shown
		? "Git footer: on."
		: "Git footer: on. It is shown in interactive mode inside a git repository, so not here.";
}

/** `/git footer` shows the saved preference; `/git footer on|off` changes it everywhere. */
export async function handleGitFooter(
	ctx: ExtensionCommandContext,
	args: string,
	footer: FooterController,
): Promise<void> {
	const choice = args.trim().toLowerCase();
	if (choice !== "" && choice !== "on" && choice !== "off") {
		ctx.ui.notify(`Unknown footer option '${args.trim()}'. ${FOOTER_USAGE}`, "error");
		return;
	}

	try {
		if (choice === "") {
			const status = await footer.status();
			ctx.ui.notify(`${describeStatus(status)}\n${FOOTER_USAGE} (saved in ${status.settingsPath})`, "info");
			return;
		}

		const status = await footer.setEnabled(ctx, choice === "on");
		ctx.ui.notify(
			`${describeStatus(status)}\nSaved for every pi session. pi windows that are already open pick it up after /reload.`,
			"info",
		);
	} catch (error) {
		if (error instanceof SettingsError) {
			ctx.ui.notify(error.message, "error");
			return;
		}
		throw error;
	}
}
