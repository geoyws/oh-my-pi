import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ALL_SCENES, selectSetupScenes } from "@oh-my-pi/pi-coding-agent/modes/setup";
import {
	cfgComposerShape,
	cfgStartupCheckUpdate,
	cfgStartupQuiet,
	cfgStartupSetupWizard,
	cfgStatusLineCompactThinkingLevel,
	cfgStatusLineContextLine,
	cfgStatusLineLeftSegments,
	cfgStatusLinePreset,
	cfgStatusLineRightSegments,
	cfgStatusLineSeparator,
	cfgStatusLineShowHookStatus,
	cfgSymbolPreset,
	cfgThemeDark,
	cfgThemeLight,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgTaskShowResolvedModelBadge } from "@oh-my-pi/pi-coding-agent/task/settings";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { getAvailableThemes } from "@oh-my-pi/pi-tui/theme/loader";

// omp t-489b1a44: a bare fork install (no PI_CONFIG_FILES overlay, empty
// ~/.omp) must look like the standard setup and must not open onboarding.
describe("fork shipped defaults", () => {
	it("defaults to the catppuccin-omp look with nerd glyphs and the borderless composer", () => {
		const settings = Settings.isolated();
		expect(cfgThemeDark.get(settings)).toBe("dark-catppuccin-omp");
		expect(cfgThemeLight.get(settings)).toBe("light-catppuccin-omp");
		expect(cfgSymbolPreset.get(settings)).toBe("nerd");
		expect(cfgComposerShape.get(settings)).toBe("borderless");
		expect(cfgStatusLinePreset.get(settings)).toBe("custom");
		expect(cfgStatusLineSeparator.get(settings)).toBe("powerline");
		expect(cfgStatusLineContextLine.get(settings)).toBe("off");
		expect(cfgStatusLineCompactThinkingLevel.get(settings)).toBe(false);
		expect(cfgStatusLineShowHookStatus.get(settings)).toBe(false);
		expect(cfgStatusLineLeftSegments.get(settings)).toEqual(["status", "model", "context_pct", "mode", "subagents"]);
		expect(cfgStatusLineRightSegments.get(settings)).toEqual(["session_name", "usage", "cost"]);
		expect(cfgStartupQuiet.get(settings)).toBe(true);
		expect(cfgStartupCheckUpdate.get(settings)).toBe(false);
		expect(cfgTaskShowResolvedModelBadge.get(settings)).toBe(true);
	});

	it("ships the default themes as built-ins with the fork's glyph overrides", async () => {
		const available = await getAvailableThemes();
		expect(available).toContain("dark-catppuccin-omp");
		expect(available).toContain("light-catppuccin-omp");

		const dark = await getThemeByName("dark-catppuccin-omp");
		const light = await getThemeByName("light-catppuccin-omp");
		expect(dark?.isLight).toBe(false);
		expect(light?.isLight).toBe(true);
		// The fork variants spell the fast mode out and drop the pie/clock glyphs.
		expect(dark?.symbol("icon.fast")).toBe("fast");
		expect(dark?.symbol("icon.context")).toBe("");
		expect(light?.symbol("icon.time")).toBe("");
	});

	it("does not select onboarding scenes on a fresh install", async () => {
		const settings = Settings.isolated();
		expect(cfgStartupSetupWizard.get(settings)).toBe(false);
		const scenes = await selectSetupScenes(0, ALL_SCENES, undefined, {
			isTTY: true,
			setupWizardEnabled: cfgStartupSetupWizard.get(settings),
		});
		expect(scenes).toEqual([]);
		// An explicit `/setup` still opens every scene.
		const forced = await selectSetupScenes(0, ALL_SCENES, undefined, {
			isTTY: true,
			setupWizardEnabled: cfgStartupSetupWizard.get(settings),
			force: true,
		});
		expect(forced.length).toBeGreaterThan(0);
	});
});
