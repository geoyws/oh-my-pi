import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

type FakeModel = { provider: string; id: string; contextWindow: number };

const MODELS: FakeModel[] = [
	{ provider: "anthropic", id: "claude-opus-4-5", contextWindow: 200_000 },
	{ provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 },
	{ provider: "openai", id: "gpt-5.2", contextWindow: 400_000 },
];

const DISCOVERED_LATER: FakeModel = { provider: "openai", id: "gpt-6.2-astra", contextWindow: 1_100_000 };

/**
 * `onRefresh` mutates the live catalog the way a registry refresh does when
 * discovery (or another process's models.db row) has published new models
 * since this session started.
 */
function createRuntime(options: { onRefresh?: (models: FakeModel[]) => void; scoped?: FakeModel[] } = {}) {
	const models = [...MODELS];
	const showModelSelector = vi.fn();
	const switchSessionModel = vi.fn(async () => {});
	const showError = vi.fn();
	const showStatus = vi.fn();
	const setText = vi.fn();
	const refresh = vi.fn(async (_strategy?: string) => options.onRefresh?.(models));
	const setModel = vi.fn(async (_model: FakeModel) => ({ switched: true }));
	const setThinkingLevel = vi.fn();
	const settings = Settings.isolated();
	return {
		showModelSelector,
		switchSessionModel,
		showError,
		setText,
		refresh,
		setModel,
		setThinkingLevel,
		settings,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				settings,
				session: {
					scopedModels: (options.scoped ?? []).map(model => ({ model })),
					modelRegistry: { getAll: () => models, getAvailable: () => models, refresh },
					setModel,
					setThinkingLevel,
				},
				routeUserModelSwitch: () => "apply",
				showModelSelector,
				switchSessionModel,
				showError,
				showStatus,
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
		expect(harness.refresh).not.toHaveBeenCalled();
	});

	it("/switch @smol resolves the configured role alias", async () => {
		const harness = createRuntime();
		harness.settings.setModelRole("smol", "openai/gpt-5.2");

		await executeBuiltinSlashCommand("/switch @smol", harness.runtime);

		expect(harness.switchSessionModel).toHaveBeenCalledWith(MODELS[2], undefined);
	});

	it("/switch reloads a stale catalog once and switches to a model discovered after startup", async () => {
		const harness = createRuntime({ onRefresh: models => models.push(DISCOVERED_LATER) });

		await executeBuiltinSlashCommand("/switch openai/gpt-6.2-astra:medium", harness.runtime);

		expect(harness.refresh.mock.calls).toEqual([["online-if-uncached"]]);
		expect(harness.switchSessionModel).toHaveBeenCalledWith(DISCOVERED_LATER, "medium");
		expect(harness.showError).not.toHaveBeenCalled();
	});

	it("/model <selector> also reloads a stale catalog before giving up", async () => {
		const harness = createRuntime({ onRefresh: models => models.push(DISCOVERED_LATER) });

		await executeBuiltinSlashCommand("/model openai/gpt-6.2-astra:medium", harness.runtime);

		expect(harness.refresh).toHaveBeenCalledTimes(1);
		expect(harness.setModel).toHaveBeenCalledWith(DISCOVERED_LATER);
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("medium");
		expect(harness.showError).not.toHaveBeenCalled();
	});

	it("/switch unknown refreshes once, then surfaces an error without opening the picker or switching", async () => {
		const harness = createRuntime();

		await executeBuiltinSlashCommand("/switch nope-9000", harness.runtime);

		expect(harness.refresh).toHaveBeenCalledTimes(1);
		expect(harness.showError).toHaveBeenCalledWith("Unknown model: nope-9000");
		expect(harness.switchSessionModel).not.toHaveBeenCalled();
		expect(harness.showModelSelector).not.toHaveBeenCalled();
	});

	it("/switch keeps the Unknown model error when the catalog refresh itself fails", async () => {
		const harness = createRuntime({
			onRefresh: () => {
				throw new Error("models.yml: parse error");
			},
		});

		await executeBuiltinSlashCommand("/switch nope-9000", harness.runtime);

		expect(harness.showError).toHaveBeenCalledWith("Unknown model: nope-9000");
		expect(harness.switchSessionModel).not.toHaveBeenCalled();
	});

	it("a --models scope never refreshes the registry on a miss", async () => {
		const harness = createRuntime({
			scoped: [MODELS[0]],
			onRefresh: models => models.push(DISCOVERED_LATER),
		});

		await executeBuiltinSlashCommand("/switch nope-9000", harness.runtime);

		expect(harness.refresh).not.toHaveBeenCalled();
		expect(harness.showError).toHaveBeenCalledWith("Unknown model: nope-9000");
	});
});
