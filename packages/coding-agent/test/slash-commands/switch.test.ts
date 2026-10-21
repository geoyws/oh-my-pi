import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

const MODELS = [
	{ provider: "anthropic", id: "claude-opus-4-5", contextWindow: 200_000 },
	{ provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 },
	{ provider: "openai", id: "gpt-5.2", contextWindow: 400_000 },
];

function createRuntime(routeOutcome: "apply" | "queued" = "apply") {
	const showModelSelector = vi.fn();
	const switchSessionModel = vi.fn(async () => {});
	const showError = vi.fn();
	const showStatus = vi.fn();
	const setText = vi.fn();
	const setModel = vi.fn(async () => ({ switched: true }));
	const routeUserModelSwitch = vi.fn((_target: unknown, _apply: () => Promise<void>) => routeOutcome);
	const settings = Settings.isolated();
	return {
		showModelSelector,
		switchSessionModel,
		showError,
		showStatus,
		setText,
		setModel,
		routeUserModelSwitch,
		settings,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				settings,
				session: {
					scopedModels: [],
					modelRegistry: { getAll: () => MODELS, getAvailable: () => MODELS },
					setModel,
					setThinkingLevel: vi.fn(),
				},
				showModelSelector,
				switchSessionModel,
				showError,
				showStatus,
				routeUserModelSwitch,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/model slash command", () => {
	it("opens the model setup picker for role and thinking assignment", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/model", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector.mock.calls).toEqual([[]]);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("/model <selector> while idle switches now and reports `Model set to ...`", async () => {
		const harness = createRuntime("apply");

		const handled = await executeBuiltinSlashCommand("/model opus", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.routeUserModelSwitch).toHaveBeenCalledTimes(1);
		expect(harness.setModel).toHaveBeenCalledWith(MODELS[0]);
		expect(harness.showStatus).toHaveBeenCalledWith("Model set to anthropic/claude-opus-4-5.");
		expect(harness.showModelSelector).not.toHaveBeenCalled();
	});

	it("/model <selector> mid-turn defers the switch and skips `Model set to ...`", async () => {
		const harness = createRuntime("queued");

		await executeBuiltinSlashCommand("/model opus", harness.runtime);

		expect(harness.routeUserModelSwitch).toHaveBeenCalledTimes(1);
		expect(harness.routeUserModelSwitch.mock.calls[0]?.[0]).toBe(MODELS[0]);
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.showStatus).not.toHaveBeenCalled();

		// The queued apply is what the turn-settle flush runs.
		await harness.routeUserModelSwitch.mock.calls[0]?.[1]();
		expect(harness.setModel).toHaveBeenCalledWith(MODELS[0]);
	});
});

describe("/switch slash command", () => {
	it("opens the temporary model selector (mirrors alt+p)", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/switch", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector).toHaveBeenCalledWith({ temporaryOnly: true });
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("/switch sonnet:high fuzzy-resolves and switches session-only with the thinking suffix", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/switch sonnet:high", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.switchSessionModel).toHaveBeenCalledWith(MODELS[1], "high");
		expect(harness.showModelSelector).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("/switch @smol resolves the configured role alias", async () => {
		const harness = createRuntime();
		harness.settings.setModelRole("smol", "openai/gpt-5.2");

		await executeBuiltinSlashCommand("/switch @smol", harness.runtime);

		expect(harness.switchSessionModel).toHaveBeenCalledWith(MODELS[2], undefined);
	});

	it("/switch unknown surfaces an error without opening the picker or switching", async () => {
		const harness = createRuntime();

		await executeBuiltinSlashCommand("/switch nope-9000", harness.runtime);

		expect(harness.showError).toHaveBeenCalledWith("Unknown model: nope-9000");
		expect(harness.switchSessionModel).not.toHaveBeenCalled();
		expect(harness.showModelSelector).not.toHaveBeenCalled();
	});
});
