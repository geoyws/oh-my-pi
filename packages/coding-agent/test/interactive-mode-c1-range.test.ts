import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Loader, Text, visibleWidth } from "@oh-my-pi/pi-tui";
import { describeSegmentTrack } from "@oh-my-pi/pi-tui/chrome/segment-track";
import type { Component } from "@oh-my-pi/pi-tui";
import type { NativeChild, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { type ObservableSession, SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import * as jobWidget from "@oh-my-pi/pi-tui/tools/job-widget";
import { resolveLocalRoot } from "../src/internal-urls/local-protocol";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { cfgComposerShape, cfgComposerTokenRate, cfgDisplayPinnedAgents } from "../src/modes/settings";
import { AgentRegistry } from "../src/registry/agent-registry";
import { EventBus } from "../src/utils/event-bus";
import { useConstructedInteractiveMode } from "./helpers/constructed-interactive-mode";

function nodes(root: NativeNode): NativeNode[] {
	const out: NativeNode[] = [root];
	for (const child of root.c ?? []) if ("k" in child) out.push(...nodes(child));
	return out;
}

function prop(node: NativeNode | NativeChild | undefined, name: string): unknown {
	return node && "p" in node && node.p ? Reflect.get(node.p, name) : undefined;
}

/** Changes a setting and lets its coalesced listener (one microtask later) apply it. */
async function change<T>(setting: { set(settings: Settings, value: T): unknown }, value: T): Promise<void> {
	setting.set(Settings.instance, value);
	await Promise.resolve();
}

describe("InteractiveMode constructed surface (C1)", () => {
	const harness = useConstructedInteractiveMode("@pi-c1-range-");
	const { createMode } = harness;

	const segment = (m: InteractiveMode, key: string) =>
		nodes(m.describeHudPills()).find(node => node.key === key && prop(node, "role") === "omp.hud.seg");

	describe("native HUD pills", () => {
		it("dock row renders nothing, describes the pills and routes segment clicks to their sheets", async () => {
			const m = createMode();
			const setChildren = vi.spyOn(m.composer, "setRuntimeChildren");
			await m.init({ suppressWelcomeIntro: true });
			const pills = setChildren.mock.calls.at(-1)![1]!.nativeDock![0] as Component & {
				describe(): NativeNode;
				handleNativeEvent(event: NativeUiEvent): void;
			};
			expect(pills.render(80)).toEqual([]);
			expect(pills.describe()).toBe(m.describeHudPills());

			const hub = vi.spyOn(m, "showAgentHub").mockImplementation(() => {});
			const jobs = vi.spyOn(m, "showJobsSheet").mockImplementation(() => {});
			// only a click action routes, even when another event names the same act
			pills.handleNativeEvent({ type: "hover", act: "agents.open" } as never);
			pills.handleNativeEvent({ type: "action", act: "pill.unknown" } as never);
			expect(hub).not.toHaveBeenCalled();
			expect(jobs).not.toHaveBeenCalled();
			pills.handleNativeEvent({ type: "action", act: "agents.open" } as never);
			expect(hub).toHaveBeenCalledTimes(1);
			expect(jobs).not.toHaveBeenCalled();
			pills.handleNativeEvent({ type: "action", act: "jobs.open" } as never);
			expect(jobs).toHaveBeenCalledTimes(1);
			expect(hub).toHaveBeenCalledTimes(1);
		});

		it("reuses an unchanged agents segment, running or idle, and hides it with pinned agents off", async () => {
			const m = createMode();
			const registry = AgentRegistry.global();
			const id = "c1-hud-agent";
			const agents = () => {
				m.syncRunningSubagentBadge({ requestRender: false });
				return segment(m, "agents");
			};
			try {
				registry.register({ id, displayName: id, kind: "sub", session: null, status: "running" });
				const running = agents();
				expect(prop(running, "title")).toStartWith("1 agent running");
				expect(agents()).toBe(running);

				registry.setStatus(id, "idle");
				const idle = agents();
				expect(prop(idle, "title")).toStartWith("No agents running · 1 in this session");
				expect(agents()).toBe(idle);

				registry.setStatus(id, "running");
				await change(cfgDisplayPinnedAgents, "off");
				expect(agents()).toBeUndefined();
				expect(m.describeHudPills()).toMatchObject({ p: { hidden: true } });
			} finally {
				registry.unregister(id);
			}
		});

		it("names a single widget job in the singular, omits an absent hover card, and pluralizes bare counts", () => {
			const m = createMode();
			const count = vi.spyOn(m.statusLine, "runningBackgroundJobCount").mockReturnValue(1);
			const widgets = vi
				.spyOn(m.session, "getRunningJobWidgets")
				.mockReturnValue([
					{ id: "bg_1", type: "bash", view: { title: "build", blocks: [], state: "live", updatedAt: 1 } },
				]);
			vi.spyOn(jobWidget, "describeJobWidgetsHovercard").mockReturnValue(undefined);
			const single = segment(m, "jobs");
			expect(prop(single, "title")).toStartWith("1 job running  /jobs\nbg_1");
			expect(single?.p && "hovercard" in single.p).toBe(false);

			count.mockReturnValue(2);
			widgets.mockReturnValue([]);
			expect(prop(segment(m, "jobs"), "title")).toBe("2 jobs running  /jobs");
		});

		it("follows the root job manager: repaints on widget and settle events, and stops listening once it is gone", () => {
			const m = createMode();
			vi.spyOn(m.statusLine, "runningBackgroundJobCount").mockReturnValue(0);
			vi.spyOn(m.session, "getRunningJobWidgets").mockReturnValue([]);
			const listeners: { widget?: () => void; settled?: () => void } = {};
			const unsubscribed = { widget: 0, settled: 0 };
			const manager = {
				widgets: {
					subscribe(listener: () => void) {
						listeners.widget = listener;
						return () => unsubscribed.widget++;
					},
				},
				onJobSettled(listener: () => void) {
					listeners.settled = listener;
					return () => unsubscribed.settled++;
				},
			};
			let current: typeof manager | undefined = manager;
			Object.defineProperty(m.session, "asyncJobManager", { configurable: true, get: () => current });
			try {
				m.describeHudPills();
				const render = vi.spyOn(m.ui, "requestRender");
				listeners.widget!();
				listeners.settled!();
				expect(render).toHaveBeenCalledTimes(2);
				// the same manager keeps its subscriptions
				m.describeHudPills();
				expect(unsubscribed).toEqual({ widget: 0, settled: 0 });

				current = undefined;
				m.describeHudPills();
				expect(unsubscribed).toEqual({ widget: 1, settled: 1 });
				m.describeHudPills();
				expect(unsubscribed).toEqual({ widget: 1, settled: 1 });
			} finally {
				Reflect.deleteProperty(m.session, "asyncJobManager");
			}
		});
	});

	describe("described dock rows", () => {
		it("describes the model cycle chip track as built and forwards invalidation to its ANSI rows", () => {
			const m = createMode();
			const segments = [{ label: "default" }, { label: "slow" }];
			m.showModelCycleTrack(segments, 1);
			const chip = m.modelCycleContainer.children[1] as Component & { describe(): NativeNode; inner: Component };
			expect(chip.describe()).toEqual(describeSegmentTrack(segments, 1));
			const invalidate = vi.fn();
			chip.inner.invalidate = invalidate;
			m.modelCycleContainer.invalidate();
			expect(invalidate).toHaveBeenCalledTimes(1);
		});

		it("describes the deferred command preview once per mount, counting queued commands", () => {
			const m = createMode();
			Object.defineProperty(m.session, "isStreaming", { configurable: true, get: () => true });
			const preview = () => m.deferredCommandContainer.children[1] as Component & { describe(): NativeNode };
			m.presentCommandOutput(new Text("usage panel", 1, 0));
			const first = preview().describe();
			expect(prop(first, "role")).toBe("omp.hud.deferred");
			expect(JSON.stringify(first)).toContain("1 command output — shown in full in the transcript");
			expect(preview().describe()).toBe(first);

			m.presentCommandOutput(new Text("advisor panel", 1, 0));
			expect(JSON.stringify(preview().describe())).toContain("2 command outputs — shown in full");
			Reflect.deleteProperty(m.session, "isStreaming");
		});
	});

	describe("idle status row trailer", () => {
		const roomy = (m: InteractiveMode) =>
			Object.defineProperty(m.ui.terminal, "rows", { configurable: true, get: () => 40 });

		it("docks the last tok/s reading and the band-mode title where the working row stood", async () => {
			const m = createMode();
			roomy(m);
			expect(m.renderIdleStatusHud(60)).toBeUndefined();
			expect(m.statusContainer.render(60)).toEqual([]);

			await change(cfgComposerTokenRate, true);
			expect(m.renderIdleStatusHud(60)).toBeUndefined();
			m.session.tokenRate.seed(1_000, 10_000);
			const rateOnly = m.statusContainer.render(60);
			expect(rateOnly[0]).toBe("");
			expect(visibleWidth(rateOnly[1]!)).toBe(60);
			expect(Bun.stripANSI(rateOnly[1]!).trim()).toEndWith("100.0 tok/s");
			// the status band is what hides the title, so other shapes never dock it here
			await m.sessionManager.setSessionName("Release prep", "user");
			expect(m.sessionName).toBe("Release prep");
			expect(Bun.stripANSI(m.renderIdleStatusHud(60)![1]!).trim()).toMatch(/^\S+ 100\.0 tok\/s$/);

			await change(cfgComposerShape, "band");
			expect(Bun.stripANSI(m.renderIdleStatusHud(60)![1]!).trim()).toMatch(/100\.0 tok\/s {2}Release prep$/);

			m.session.tokenRate.reset();
			expect(Bun.stripANSI(m.renderIdleStatusHud(60)![1]!).trim()).toBe("Release prep");
			// an unnamed session in band mode has nothing to dock
			vi.spyOn(m.sessionManager, "getSessionName").mockReturnValue(undefined);
			expect(m.renderIdleStatusHud(60)).toBeUndefined();
		});
	});

	describe("working row", () => {
		it("offers the interrupt key only while unfocused, defaulting to Esc when none is bound", () => {
			const m = createMode();
			const bound = m.keybindings.getKeys("app.interrupt")[0];
			expect(bound).toBeDefined();
			expect(m.maintenanceInterruptKey()).toBe(bound);
			const keys = vi.spyOn(m.keybindings, "getKeys").mockReturnValue([]);
			expect(m.maintenanceInterruptKey()).toBe("escape");
			keys.mockRestore();
			Object.defineProperty(m, "focusedAgentId", { configurable: true, get: () => "Alpha" });
			expect(m.maintenanceInterruptKey()).toBeUndefined();
		});

		it("reads a live label each time, uses no shimmer palette without a session accent, and falls back to Esc", () => {
			const m = createMode();
			const setRow = vi.spyOn(Loader.prototype, "setWorkingRow");
			m.ensureLoadingAnimation();
			const spec = setRow.mock.calls.at(-1)![0];
			let step = "Compiling";
			m.setWorkingMessage(() => step);
			expect(spec()).toMatchObject({ label: "Compiling", palette: undefined });
			step = "Linking";
			expect(spec().label).toBe("Linking");
			expect(spec().interruptKey).toBe(m.keybindings.getKeys("app.interrupt")[0]);
			vi.spyOn(m.keybindings, "getKeys").mockReturnValue([]);
			expect(spec().interruptKey).toBe("escape");
		});

		it("stops the compaction and retry loaders when the session's transient UI is cleared", () => {
			const m = createMode();
			const compaction = { stop: vi.fn() };
			const retry = { stop: vi.fn() };
			m.autoCompactionLoader = compaction as never;
			m.retryLoader = retry as never;
			m.clearTransientSessionUi();
			expect(compaction.stop).toHaveBeenCalledTimes(1);
			expect(retry.stop).toHaveBeenCalledTimes(1);
			expect(m.autoCompactionLoader).toBeUndefined();
			expect(m.retryLoader).toBeUndefined();
		});
	});

	describe("pinned subagent jump list", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("flips between the collapsed few and the full list from the setting's default", async () => {
			const sessions: ObservableSession[] = Array.from({ length: 5 }, (_, i) => ({
				id: `Agent${i}`,
				kind: "subagent",
				status: "active",
				lastUpdate: Date.now(),
				description: `work ${i}`,
			})) as ObservableSession[];
			vi.spyOn(SessionObserverRegistry.prototype, "getSessions").mockImplementation(() => sessions);
			const m = createMode();
			await m.init({ suppressWelcomeIntro: true });
			const hud = () => Bun.stripANSI(m.subagentContainer.render(120).join("\n"));
			m.applyPinnedAgentsSetting();
			expect(hud()).toContain("2 more — expand");
			expect(hud()).not.toContain("work 4");

			const render = vi.spyOn(m.ui, "requestRender");
			m.togglePinnedHudExpanded();
			expect(hud()).toContain("work 4");
			expect(hud()).toContain("show less");
			m.togglePinnedHudExpanded();
			expect(hud()).toContain("2 more — expand");
			expect(render).toHaveBeenCalledTimes(2);
		});
	});

	describe("context accessors", () => {
		it("exposes the event buses it was built with", () => {
			const bus = new EventBus();
			const subagentBus = new EventBus();
			const m = createMode(bus);
			expect(m.eventBus).toBe(bus);
			expect(m.subagentEventBus).toBeUndefined();
			const routed = new InteractiveMode(
				m.session,
				"test",
				undefined,
				undefined,
				undefined,
				undefined,
				bus,
				undefined,
				subagentBus,
			);
			try {
				expect(routed.subagentEventBus).toBe(subagentBus);
			} finally {
				routed.stop();
			}
		});

		it("resolves link targets against the viewed session's cwd and local:// root", async () => {
			const m = createMode();
			const manager = m.session.sessionManager;
			const root = resolveLocalRoot({
				getArtifactsDir: () => manager.getArtifactsDir(),
				getSessionId: () => manager.getSessionId(),
			});
			fs.mkdirSync(root, { recursive: true });
			try {
				fs.writeFileSync(path.join(root, "plan.md"), "# plan\n");
				fs.writeFileSync(path.join(manager.getCwd(), "notes.md"), "notes\n");
				const targets = await m.resolveAssistantMessageLinkHrefs(["local://plan.md", "notes.md#top", "missing.md"]);
				expect(targets.get("local://plan.md")).toEndWith("/plan.md");
				expect(targets.get("notes.md#top")).toEndWith("/notes.md#top");
				expect(targets.has("missing.md")).toBe(false);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});

		it("resolves local:// links under the session-id root when the session has no artifacts dir", async () => {
			const m = createMode();
			const manager = m.session.sessionManager;
			vi.spyOn(manager, "getArtifactsDir").mockReturnValue(null);
			const root = resolveLocalRoot({ getSessionId: () => manager.getSessionId() });
			expect(root).toContain(manager.getSessionId());
			fs.mkdirSync(root, { recursive: true });
			try {
				fs.writeFileSync(path.join(root, "scratch.md"), "scratch\n");
				const targets = await m.resolveAssistantMessageLinkHrefs(["local://scratch.md"]);
				expect(targets.get("local://scratch.md")).toEndWith(`/${path.basename(root)}/scratch.md`);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});

		it("leaves focus untouched when asked for a parent or to drop a pending focus with none in flight", async () => {
			const m = createMode();
			m.invalidatePendingFocus();
			await m.focusParentSession();
			expect(m.focusedAgentId).toBeUndefined();
			expect(m.viewSession).toBe(m.session);
		});

		it("routes viewport click candidates and the hovered click id through the composer", () => {
			const m = createMode();
			const candidates = vi.spyOn(m.composer, "viewportClickCandidates").mockReturnValue(["agent:Alpha"]);
			expect(m.resolveViewportClickCandidates(3)).toEqual(["agent:Alpha"]);
			expect(candidates).toHaveBeenCalledWith(3);
			const hover = vi.spyOn(m.composer, "setHoveredClickId");
			m.setClickHoverId("agent:Alpha");
			m.setClickHoverId(undefined);
			expect(hover.mock.calls).toEqual([["agent:Alpha"], [undefined]]);
		});
	});
});
