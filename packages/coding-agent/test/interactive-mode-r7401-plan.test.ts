/**
 * InteractiveMode plan review from line 7700: opening a review from disk, the
 * plan file it resolves, the execution-tier slider, overlay callbacks, and the
 * failure paths of each review choice.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

type ReviewOptions = NonNullable<Parameters<InteractiveMode["showPlanReview"]>[3]>;
type ReviewExtras = Parameters<InteractiveMode["showPlanReview"]>[4];

describe("InteractiveMode plan review (lines 7700-8041)", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: TempDir;
	let session: AgentSession;
	let mode: InteractiveMode;
	let warnings: string[];
	let statuses: string[];
	let errors: string[];

	function planPath(url: string): string {
		return resolveLocalUrlToPath(url, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
	}

	async function writePlan(url: string, content: string): Promise<void> {
		await Bun.write(planPath(url), content);
	}

	// bun's spyOn cannot wrap accessors yet: stub prototype getters by hand and restore them after each test.
	const stubbedGetters: Array<{ proto: object; prop: string; descriptor: PropertyDescriptor }> = [];
	function stubGetter(proto: object, prop: string, get: () => unknown): void {
		const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
		if (!descriptor) throw new Error(`no accessor ${prop}`);
		stubbedGetters.push({ proto, prop, descriptor });
		Object.defineProperty(proto, prop, { ...descriptor, get });
	}

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		sharedDir = TempDir.createSync("@pi-im-r7401-plan-shared-");
		await Settings.init({ inMemory: true, cwd: sharedDir.path() });
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-im-r7401-plan-");
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.planModeEnabled = true;
		warnings = [];
		statuses = [];
		errors = [];
		spyOn(mode, "showWarning").mockImplementation(message => void warnings.push(message));
		spyOn(mode, "showStatus").mockImplementation(message => void statuses.push(message));
		spyOn(mode, "showError").mockImplementation(message => void errors.push(message));
	});

	afterEach(async () => {
		for (const { proto, prop, descriptor } of stubbedGetters.splice(0).reverse()) {
			Object.defineProperty(proto, prop, descriptor);
		}
		vi.restoreAllMocks();
		mode.stop();
		await session.dispose();
		tempDir.removeSync();
	});

	afterAll(() => {
		authStorage?.close();
		sharedDir?.removeSync();
		resetSettingsForTest();
	});

	describe("openPlanReview", () => {
		beforeEach(async () => {
			await writePlan("local://ship-plan.md", "# Ship\n\nDo it.");
		});

		it("reports a review that failed before it opened", async () => {
			spyOn(mode, "handlePlanApproval").mockRejectedValue(new Error("overlay crashed"));

			expect(await mode.openPlanReview()).toBe(false);

			expect(errors).toEqual(["Failed to open plan review: overlay crashed"]);
		});

		it("reports a review that failed after it opened, including non-Error failures", async () => {
			spyOn(mode, "handlePlanApproval").mockImplementation(async (_details, options) => {
				options?.onOpened?.();
				throw "answer lost";
			});

			expect(await mode.openPlanReview()).toBe(true);
			await Bun.sleep(0);

			expect(errors).toEqual(["Plan review failed: answer lost"]);
		});
	});

	describe("handlePlanApproval", () => {
		it("warns and shows nothing outside plan mode", async () => {
			mode.planModeEnabled = false;
			const review = spyOn(mode, "showPlanReview");

			await mode.handlePlanApproval({ planFilePath: "local://PLAN.md", title: "PLAN", planExists: true });

			expect(warnings).toEqual(["Plan mode is not active."]);
			expect(review).not.toHaveBeenCalled();
		});

		it("reports a missing plan file", async () => {
			const review = spyOn(mode, "showPlanReview");

			await mode.handlePlanApproval({ planFilePath: "local://gone-plan.md", title: "Gone", planExists: true });

			expect(errors).toEqual(["Plan file not found at local://gone-plan.md"]);
			expect(review).not.toHaveBeenCalled();
		});

		it("falls back to the plan-mode file, then to the session's plan reference", async () => {
			await writePlan("local://mode-plan.md", "# From plan mode");
			await writePlan("local://PLAN.md", "# Default plan");
			const review = spyOn(mode, "showPlanReview").mockResolvedValue(undefined);

			mode.planModePlanFilePath = "local://mode-plan.md";
			await mode.handlePlanApproval({ planFilePath: "", title: "T", planExists: true });
			mode.planModePlanFilePath = undefined;
			await mode.handlePlanApproval({ planFilePath: "", title: "T", planExists: true });

			expect(review.mock.calls.map(call => call[0])).toEqual(["# From plan mode", "# Default plan"]);
			expect(mode.planModePlanFilePath).toBe("local://PLAN.md");
		});

		it("without the abort barrier, refuses to mount over a turn that started while the plan was read", async () => {
			await writePlan("local://busy-plan.md", "# Busy");
			stubGetter(AgentSession.prototype, "isStreaming", () => true);
			const review = spyOn(mode, "showPlanReview");

			await mode.handlePlanApproval(
				{ planFilePath: "local://busy-plan.md", title: "Busy", planExists: true },
				{ abortTurn: false },
			);

			expect(review).not.toHaveBeenCalled();
		});

		describe("execution-tier slider", () => {
			const model = (id: string, name: string) => ({ id, name, provider: "test" }) as never;

			beforeEach(async () => {
				await writePlan("local://tier-plan.md", "# Tiers");
			});

			async function sliderFor(cycle: unknown): Promise<ReviewExtras> {
				spyOn(session, "getRoleModelCycle").mockReturnValue(cycle as never);
				const review = spyOn(mode, "showPlanReview").mockResolvedValue(undefined);
				await mode.handlePlanApproval({ planFilePath: "local://tier-plan.md", title: "Tiers", planExists: true });
				return review.mock.calls[0]?.[4];
			}

			it("is hidden without a role cycle", async () => {
				expect(await sliderFor(undefined)).toEqual({ slider: undefined });
			});

			it("starts on the cycle's current tier when no default role exists, labelling unnamed models by id", async () => {
				const extras = await sliderFor({
					models: [
						{ role: "smol", model: model("m-small", "") },
						{ role: "slow", model: model("m-slow", "Slow One") },
					],
					currentIndex: 1,
				});

				expect(extras?.slider?.index).toBe(1);
				expect(extras?.slider?.segments).toEqual([
					{ label: "smol", detail: "m-small" },
					{ label: "slow", detail: "Slow One" },
				]);
			});

			it("starts on the first tier when the cycle has neither a default role nor a current index", async () => {
				const extras = await sliderFor({
					models: [
						{ role: "smol", model: model("m-small", "Small") },
						{ role: "slow", model: model("m-slow", "Slow") },
					],
				});

				expect(extras?.slider?.index).toBe(0);
			});
		});

		describe("overlay callbacks", () => {
			beforeEach(async () => {
				await writePlan("local://cb-plan.md", "# Callbacks");
			});

			async function openWith(choice: string | undefined): Promise<ReviewOptions> {
				const review = spyOn(mode, "showPlanReview").mockResolvedValue(choice);
				await mode.handlePlanApproval({ planFilePath: "local://cb-plan.md", title: "CB", planExists: true });
				const options = review.mock.calls.at(-1)?.[3];
				if (!options) throw new Error("expected review options");
				return options;
			}

			it("the external-editor action warns when no editor is configured", async () => {
				const saved = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR };
				delete process.env.VISUAL;
				delete process.env.EDITOR;
				try {
					const options = await openWith(undefined);
					options.onExternalEditor?.();
					await Bun.sleep(0);
				} finally {
					if (saved.VISUAL !== undefined) process.env.VISUAL = saved.VISUAL;
					if (saved.EDITOR !== undefined) process.env.EDITOR = saved.EDITOR;
				}

				expect(warnings).toEqual(["No editor configured. Set $VISUAL or $EDITOR environment variable."]);
			});

			it("annotations survive into the next review and are forgotten once cleared", async () => {
				const first = await openWith(undefined);
				const annotated = { annotations: [{ id: "a1" }] } as never;
				first.onAnnotationStateChange?.(annotated);

				const second = await openWith(undefined);
				expect(second.annotationState).toBe(annotated);
				second.onAnnotationStateChange?.({ annotations: [] } as never);

				const third = await openWith(undefined);
				expect(third.annotationState).toBeUndefined();
			});
		});

		it("still reports the overlay closing when delivering the request to extensions failed", async () => {
			await writePlan("local://ext-plan.md", "# Ext");
			const events: ExtensionEvent[] = [];
			Object.defineProperty(session, "extensionRunner", {
				configurable: true,
				get: () => ({
					emit: (event: ExtensionEvent) => {
						events.push(event);
						return event.type === "plan_review_requested"
							? Promise.reject(new Error("handler threw"))
							: Promise.resolve();
					},
				}),
			});
			spyOn(mode, "showPlanReview").mockImplementation(async (_content, _title, _labels, options) => {
				options?.onClose?.("Refine plan");
				return "Refine plan";
			});

			await mode.handlePlanApproval({ planFilePath: "local://ext-plan.md", title: "Ext", planExists: true });
			await Bun.sleep(0);

			expect(events.map(event => event.type)).toEqual(["plan_review_requested", "plan_review_resolved"]);
			expect(events[1]).toMatchObject({ choice: "refine", by: "local" });
		});

		describe("choice failures", () => {
			const url = "local://choice-plan.md";

			beforeEach(async () => {
				await writePlan(url, "# Choice");
			});

			/** Pick `choice`, optionally deleting the plan file while the overlay is up. */
			async function pick(choice: string, deleteWhileOpen = false): Promise<void> {
				spyOn(mode, "showPlanReview").mockImplementation(async () => {
					if (deleteWhileOpen) await fs.rm(planPath(url));
					return choice;
				});
				await mode.handlePlanApproval({ planFilePath: url, title: "Choice", planExists: true });
			}

			it("save reports a plan deleted while the review was open", async () => {
				await pick("Save and quit", true);

				expect(errors).toEqual([`Plan file not found at ${url}`]);
			});

			it.each([
				["an Error", new Error("prompt crashed"), "prompt crashed"],
				["a non-Error", "prompt gone", "prompt gone"],
			])("save reports %s thrown while asking where to save", async (_label, failure, detail) => {
				spyOn(session, "generateTitle").mockResolvedValue(undefined as never);
				spyOn(mode, "showHookCustom").mockRejectedValue(failure);

				await pick("Save and quit");

				expect(errors).toEqual([`Failed to save plan: ${detail}`]);
			});

			it("approval reports a plan deleted while the review was open", async () => {
				await pick("Approve and execute", true);

				expect(errors).toEqual([`Plan file not found at ${url}`]);
				expect(mode.planModeEnabled).toBe(true);
			});

			it("approval reports a non-Error failure as text", async () => {
				spyOn(session, "getAllToolNames").mockImplementation(() => {
					throw "tool registry gone";
				});

				await pick("Approve and execute");

				expect(errors).toEqual(["Failed to finalize approved plan: tool registry gone"]);
			});

			it.each([
				["an Error", new Error("provider down"), "provider down"],
				["a non-Error", "socket closed", "socket closed"],
			])("refine without an input callback reports %s from the follow-up prompt", async (_label, failure, detail) => {
				const prompt = spyOn(session, "prompt").mockRejectedValue(failure);
				spyOn(mode, "showPlanReview").mockImplementation(async (_content, _title, _labels, options) => {
					options?.onFeedbackChange?.("tighten step 2");
					return "Refine plan";
				});

				await mode.handlePlanApproval({ planFilePath: url, title: "Choice", planExists: true });

				expect(prompt).toHaveBeenCalledWith("tighten step 2");
				expect(errors).toEqual([`Failed to refine plan: ${detail}`]);
			});
		});
	});
});
