import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgGoalContinuationModes, cfgGoalEnabled } from "@oh-my-pi/pi-coding-agent/goals/settings";
import { RpcGoalController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgAsyncEnabled, cfgToolsXdev } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("RpcGoalController", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let controller: RpcGoalController | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-rpc-goal-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
	});

	afterEach(async () => {
		controller?.dispose();
		controller = undefined;
		await session?.dispose();
		session = undefined;
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	async function makeSession(sessionManager = SessionManager.inMemory(tempDir.path())): Promise<AgentSession> {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.instance;
		cfgAsyncEnabled.set(settings, false);
		cfgToolsXdev.set(settings, true);
		cfgGoalEnabled.set(settings, true);
		const { session: created } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry,
			settings,
			model: getBundledModel("anthropic", "claude-sonnet-4-5"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: tempDir.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		return created;
	}

	it("set/pause/resume/drop drive the goal runtime and the goal tool", async () => {
		session = await makeSession();
		controller = new RpcGoalController(session);
		controller.attach();
		expect(session.getEnabledToolNames()).not.toContain("goal");

		const created = await controller.handle({ action: "set", objective: "ship it", tokenBudget: 5000 });
		expect(created?.goal.objective).toBe("ship it");
		expect(created?.goal.tokenBudget).toBe(5000);
		expect(created?.goal.status).toBe("active");
		expect(session.getEnabledToolNames()).toContain("goal");
		expect(session.sessionManager.buildSessionContext().mode).toBe("goal");

		const paused = await controller.handle({ action: "pause" });
		expect(paused?.goal.status).toBe("paused");
		expect(paused?.enabled).toBe(false);
		expect(session.sessionManager.buildSessionContext().mode).toBe("goal_paused");

		const resumed = await controller.handle({ action: "resume" });
		expect(resumed?.goal.status).toBe("active");
		expect((await controller.handle({ action: "get" }))?.goal.id).toBe(created?.goal.id);

		const dropped = await controller.handle({ action: "drop" });
		expect(dropped).toBeUndefined();
		expect(session.getGoalModeState()).toBeUndefined();
		expect(session.getEnabledToolNames()).not.toContain("goal");
		expect(session.sessionManager.buildSessionContext().mode).toBe("none");
	});

	it("rejects pause and resume without a matching goal", async () => {
		session = await makeSession();
		controller = new RpcGoalController(session);
		await expect(controller.handle({ action: "pause" })).rejects.toThrow("No active goal");
		await expect(controller.handle({ action: "resume" })).rejects.toThrow("No paused goal");
		await expect(controller.handle({ action: "set", objective: "  " })).rejects.toThrow("objective");
	});

	it("restores a persisted goal on resume and re-enables the goal tool", async () => {
		const sessionDir = tempDir.join("sessions");
		session = await makeSession(SessionManager.create(tempDir.path(), sessionDir));
		controller = new RpcGoalController(session);
		// A session file only materializes once an assistant message exists;
		// mode_change entries alone stay draft-only and never hit disk.
		session.sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const created = await controller.handle({ action: "set", objective: "persisted" });
		const sessionFile = session.sessionManager.getSessionFile();
		expect(sessionFile).toBeTruthy();
		controller.dispose();
		await session.dispose();

		session = await makeSession(await SessionManager.open(sessionFile!, sessionDir));
		expect(session.getGoalModeState()).toBeUndefined();
		controller = new RpcGoalController(session);
		await controller.restoreFromSession();
		// GoalRuntime.onThreadResumed() parks an active goal as paused; the
		// host re-activates it explicitly.
		expect(session.getGoalModeState()?.goal.id).toBe(created?.goal.id);
		expect(session.getGoalModeState()?.goal.status).toBe("paused");
		expect(session.getGoalModeState()?.enabled).toBe(false);
		expect(session.getEnabledToolNames()).toContain("goal");
		const resumed = await controller.handle({ action: "resume" });
		expect(resumed?.goal.status).toBe("active");
		expect(resumed?.enabled).toBe(true);
	});

	it("continuation is gated on goal.continuationModes including rpc", async () => {
		session = await makeSession();
		const modes = cfgGoalContinuationModes.get(Settings.instance);
		expect(modes).toContain("rpc");
		controller = new RpcGoalController(session);
		await controller.handle({ action: "set", objective: "x" });
		expect(session.goalRuntime.buildContinuationPrompt()).toBeTruthy();
	});
});
