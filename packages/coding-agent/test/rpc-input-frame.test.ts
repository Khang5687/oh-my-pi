import { describe, expect, spyOn, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ManagedDispatchRefusedError } from "@oh-my-pi/pi-ai/auth-retry";
import type { ManagedAttemptOutcome } from "@oh-my-pi/pi-ai/auth/types";
import * as claudeUsage from "@oh-my-pi/pi-ai/usage/claude";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	consumeHostAccountRoutingMarker,
	ManagedAccountRoutingAdapter,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/account-routing";
import { RpcHostToolBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-tools";
import { readRpcInputFrames } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-input";
import {
	dispatchRpcInputFrame,
	type PendingExtensionRequest,
	RpcInputDispatcher,
	type RpcInputFrameDeps,
	RpcPendingExtensionRequests,
	RpcShutdownCoordinator,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type {
	RpcCommand,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcResponse,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";

type OutputFrame = RpcResponse | object;

const makeDeps = (
	handleCommand: RpcInputFrameDeps["handleCommand"],
	options?: { pendingExtensionRequests?: Map<string, PendingExtensionRequest> },
) => {
	const outputs: OutputFrame[] = [];
	const deps: RpcInputFrameDeps = {
		handleCommand,
		output: obj => {
			outputs.push(obj as OutputFrame);
		},
		errorResponse: (id, command, message) => ({
			id,
			type: "response",
			command,
			success: false,
			error: message,
		}),
		pendingExtensionRequests: options?.pendingExtensionRequests ?? new Map<string, PendingExtensionRequest>(),
		onHostToolResult: () => {},
		onHostToolUpdate: () => {},
		onHostUriResult: () => {},
	};
	return { deps, outputs };
};

const flushMicrotasks = () => new Promise<void>(resolve => setImmediate(resolve));

const requestExtensionInput = (deps: RpcInputFrameDeps, id: string, message: string) => {
	const response = Promise.withResolvers<RpcExtensionUIResponse>();
	deps.pendingExtensionRequests.set(id, {
		resolve: response.resolve,
		reject: error => response.reject(error),
	});
	deps.output({
		type: "extension_ui_request",
		id,
		method: "input",
		message,
	});
	return response.promise;
};

const cancelledBashResponse = (id: string): RpcResponse => ({
	id,
	type: "response",
	command: "bash",
	success: true,
	data: {
		output: "",
		exitCode: -1,
		cancelled: true,
		truncated: false,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
	},
});

describe("dispatchRpcInputFrame", () => {
	test("bash is dispatched in the background so abort_bash preempts it (issue #4079 A)", async () => {
		const { promise: bashPending, resolve: resolveBash } = Promise.withResolvers<RpcResponse>();
		let abortBashCalled = false;

		const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
			if (command.type === "bash") {
				// Block until abort_bash resolves the shared promise.
				return await bashPending;
			}
			if (command.type === "abort_bash") {
				abortBashCalled = true;
				// Emulate `session.abortBash()` cancelling the in-flight bash so
				// the queued executeBash promise resolves with cancelled=true.
				resolveBash(cancelledBashResponse("b1"));
				return { id: command.id, type: "response", command: "abort_bash", success: true };
			}
			throw new Error(`unexpected command type: ${command.type}`);
		};

		const { deps, outputs } = makeDeps(handleCommand);

		// Kick off bash. If the fix works, dispatchRpcInputFrame returns
		// undefined immediately without waiting for handleCommand.
		const bashAwait = dispatchRpcInputFrame({ id: "b1", type: "bash", command: "sleep 9999" }, deps);
		expect(bashAwait).toBeUndefined();
		await flushMicrotasks();
		expect(outputs).toHaveLength(0);

		// Now dispatch abort_bash. It must run serially (not backgrounded)
		// and resolve after handleCommand completes.
		const abortAwait = dispatchRpcInputFrame({ id: "a1", type: "abort_bash" }, deps);
		expect(abortAwait).toBeInstanceOf(Promise);
		await abortAwait;

		expect(abortBashCalled).toBe(true);
		expect(outputs[0]).toEqual({
			id: "a1",
			type: "response",
			command: "abort_bash",
			success: true,
		});

		// The background bash response arrives after abort_bash.
		await flushMicrotasks();
		expect(outputs).toHaveLength(2);
		const bashFrame = outputs[1] as RpcResponse;
		expect(bashFrame.command).toBe("bash");
		expect(bashFrame.success).toBe(true);
		if (bashFrame.command === "bash" && bashFrame.success) {
			expect(bashFrame.data.cancelled).toBe(true);
			expect(bashFrame.data.exitCode).toBe(-1);
		}
	});

	test("bash handler errors surface as an error response on the background frame", async () => {
		const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
			if (command.type === "bash") throw new Error("kaboom");
			throw new Error(`unexpected: ${command.type}`);
		};

		const { deps, outputs } = makeDeps(handleCommand);

		const awaited = dispatchRpcInputFrame({ id: "b2", type: "bash", command: "echo hi" }, deps);
		expect(awaited).toBeUndefined();

		// Give the background dispatch a chance to run its catch.
		await flushMicrotasks();
		await flushMicrotasks();

		expect(outputs).toHaveLength(1);
		expect(outputs[0]).toEqual({
			id: "b2",
			type: "response",
			command: "bash",
			success: false,
			error: "kaboom",
		});
	});

	test("background bash task is exposed so EOF cleanup can await its response", async () => {
		const bashResponse: RpcResponse = {
			id: "b3",
			type: "response",
			command: "bash",
			success: true,
			data: {
				output: "done",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 4,
				outputLines: 1,
				outputBytes: 4,
			},
		};
		const { promise: bashPending, resolve: resolveBash } = Promise.withResolvers<RpcResponse>();
		const { deps, outputs } = makeDeps(async command => {
			if (command.type === "bash") return await bashPending;
			throw new Error(`unexpected: ${command.type}`);
		});
		let trackedTask: Promise<void> | undefined;
		deps.trackBackgroundTask = task => {
			trackedTask = task;
		};

		const awaited = dispatchRpcInputFrame({ id: "b3", type: "bash", command: "echo done" }, deps);
		expect(awaited).toBeUndefined();
		expect(trackedTask).toBeInstanceOf(Promise);
		expect(outputs).toHaveLength(0);

		resolveBash(bashResponse);
		await trackedTask;

		expect(outputs).toEqual([bashResponse]);
	});
});

describe("RpcInputDispatcher", () => {
	test("control frames resolve extension UI requests while an ordinary command is active", async () => {
		const { deps, outputs } = makeDeps(async command => {
			if (command.type !== "get_state") throw new Error(`unexpected command type: ${command.type}`);
			const response = await requestExtensionInput(depsRef, "ui-active", "Continue?");
			return {
				id: command.id,
				type: "response",
				command: "get_state",
				success: true,
				data: { agentInvoked: "value" in response && response.value === "continue" },
			} as unknown as RpcResponse;
		});
		const depsRef = deps;
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "cmd-1", type: "get_state" });
		await flushMicrotasks();

		expect(outputs).toEqual([
			{
				type: "extension_ui_request",
				id: "ui-active",
				method: "input",
				message: "Continue?",
			},
		]);

		dispatcher.dispatch({ type: "extension_ui_response", id: "ui-active", value: "continue" });
		await dispatcher.drain();

		expect(outputs).toEqual([
			{
				type: "extension_ui_request",
				id: "ui-active",
				method: "input",
				message: "Continue?",
			},
			{
				id: "cmd-1",
				type: "response",
				command: "get_state",
				success: true,
				data: { agentInvoked: true },
			},
		]);
	});

	test("malformed frames emit a parse error without ending the input reader", () => {
		const { deps, outputs } = makeDeps(async command => ({
			id: command.id,
			type: "response",
			command: "prompt",
			success: true,
			data: { agentInvoked: false },
		}));
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch(null);

		expect(outputs).toEqual([
			expect.objectContaining({
				type: "response",
				command: "parse",
				success: false,
				error: expect.stringContaining("Failed to parse command:"),
			}),
		]);
	});

	test("ordinary commands stay serialized while first command is blocked", async () => {
		const releaseFirst = Promise.withResolvers<void>();
		const started: string[] = [];
		const { deps, outputs } = makeDeps(async command => {
			started.push(command.type);
			if (command.type === "abort_retry") {
				await releaseFirst.promise;
				return { id: command.id, type: "response", command: "abort_retry", success: true };
			}
			if (command.type === "get_state") {
				return {
					id: command.id,
					type: "response",
					command: "get_state",
					success: true,
					data: {
						thinkingLevel: undefined,
						isStreaming: false,
						isCompacting: false,
						steeringMode: "all",
						followUpMode: "all",
						interruptMode: "immediate",
						sessionId: "session-1",
						autoCompactionEnabled: false,
						fastModeEnabled: false,
						fastModeActive: false,
						slowModeSupported: false,
						slowModeEnabled: false,
						tokensPerSecond: null,
						messageCount: 0,
						queuedMessageCount: 0,
						hasPendingAsyncWork: false,
						isSettled: true,
						queuedMessages: { steering: [], followUp: [], liveSteered: 0 },
						todoPhases: [],
						goal: null,
					},
				};
			}
			throw new Error(`unexpected command type: ${command.type}`);
		});
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "first", type: "abort_retry" });
		dispatcher.dispatch({ id: "second", type: "get_state" });
		await flushMicrotasks();

		expect(started).toEqual(["abort_retry"]);
		expect(outputs).toHaveLength(0);

		releaseFirst.resolve();
		await dispatcher.drain();

		expect(started).toEqual(["abort_retry", "get_state"]);
		expect((outputs[0] as RpcResponse).id).toBe("first");
		expect((outputs[1] as RpcResponse).id).toBe("second");
		expect((outputs[1] as RpcResponse).command).toBe("get_state");
	});

	test("a steer_subagent waiting for the subagent to accept does not block a later abort", async () => {
		const accepted = Promise.withResolvers<void>();
		const started: string[] = [];
		const { deps, outputs } = makeDeps(async command => {
			started.push(command.type);
			if (command.type === "steer_subagent") {
				await accepted.promise;
				return { id: command.id, type: "response", command: "steer_subagent", success: true };
			}
			if (command.type === "abort") return { id: command.id, type: "response", command: "abort", success: true };
			throw new Error(`unexpected command type: ${command.type}`);
		});
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "steer", type: "steer_subagent", subagentId: "SubagentA", message: "go" });
		dispatcher.dispatch({ id: "abort", type: "abort" });
		await flushMicrotasks();

		expect(started).toEqual(["steer_subagent", "abort"]);
		expect(outputs.map(frame => (frame as RpcResponse).id)).toEqual(["abort"]);

		accepted.resolve();
		await flushMicrotasks();
		expect(outputs.map(frame => (frame as RpcResponse).id)).toEqual(["abort", "steer"]);
	});

	test("a pending predict_word does not hold back later commands", async () => {
		const releasePrediction = Promise.withResolvers<void>();
		const { deps, outputs } = makeDeps(async command => {
			if (command.type === "predict_word") {
				await releasePrediction.promise;
				return { id: command.id, type: "response", command: "predict_word", success: true, data: { suffix: "er" } };
			}
			if (command.type === "abort_retry") {
				return { id: command.id, type: "response", command: "abort_retry", success: true };
			}
			throw new Error(`unexpected command type: ${command.type}`);
		});
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "predict", type: "predict_word", text: "The weath", cursor: 9 });
		dispatcher.dispatch({ id: "after", type: "abort_retry" });
		await dispatcher.drain();
		expect(outputs.map(frame => (frame as RpcResponse).id)).toEqual(["after"]);

		releasePrediction.resolve();
		await flushMicrotasks();
		expect(outputs.map(frame => (frame as RpcResponse).id)).toEqual(["after", "predict"]);
	});

	test("a prompt waits for an earlier session change without blocking a later abort", async () => {
		const reset = Promise.withResolvers<void>();
		const admission = Promise.withResolvers<void>();
		let currentSession = "old";
		let promptedSession: string | undefined;
		let background: Promise<void> | undefined;
		const { deps, outputs } = makeDeps(async command => {
			if (command.type === "new_session") {
				await reset.promise;
				currentSession = "new";
				return {
					id: command.id,
					type: "response",
					command: "new_session",
					success: true,
					data: { cancelled: false },
				};
			}
			if (command.type === "prompt") {
				promptedSession = currentSession;
				await admission.promise;
				return { id: command.id, type: "response", command: "prompt", success: true };
			}
			if (command.type === "abort") {
				return { id: command.id, type: "response", command: "abort", success: true };
			}
			throw new Error(`unexpected command type: ${command.type}`);
		});
		deps.trackBackgroundTask = task => {
			background = task;
		};
		const dispatcher = new RpcInputDispatcher({ deps });
		try {
			dispatcher.dispatch({ id: "reset", type: "new_session" });
			dispatcher.dispatch({ id: "prompt", type: "prompt", message: "use the new session" });
			dispatcher.dispatch({ id: "abort", type: "abort" });
			await flushMicrotasks();
			expect(promptedSession).toBeUndefined();
			reset.resolve();
			await dispatcher.drain();
			expect(promptedSession).toBe("new");
			expect(outputs.map(frame => (frame as RpcResponse).id)).toEqual(["reset", "abort"]);
		} finally {
			reset.resolve();
			admission.resolve();
			await dispatcher.drain();
			await background;
		}
		expect(outputs.map(frame => (frame as RpcResponse).id)).toEqual(["reset", "abort", "prompt"]);
	});

	test("serial command rejection emits an error response and does not poison the queue", async () => {
		const started: string[] = [];
		const { deps, outputs } = makeDeps(async command => {
			started.push(command.type);
			if (command.type === "abort_retry") throw new Error("retry controller exploded");
			if (command.type === "set_auto_retry") {
				return { id: command.id, type: "response", command: "set_auto_retry", success: true };
			}
			throw new Error(`unexpected command type: ${command.type}`);
		});
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "bad", type: "abort_retry" });
		dispatcher.dispatch({ id: "next", type: "set_auto_retry", enabled: true });
		await dispatcher.drain();

		expect(started).toEqual(["abort_retry", "set_auto_retry"]);
		expect(outputs).toEqual([
			{
				id: "bad",
				type: "response",
				command: "abort_retry",
				success: false,
				error: "retry controller exploded",
			},
			{
				id: "next",
				type: "response",
				command: "set_auto_retry",
				success: true,
			},
		]);
	});

	test("drain after EOF rejects active and queued host tool requests without emitting new calls", async () => {
		const disconnectMessage = "RPC client disconnected before host tool execution completed";
		const hostToolFrames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const bridge = new RpcHostToolBridge(frame => {
			hostToolFrames.push(frame);
		});
		const [tool] = bridge.setTools([
			{
				name: "host_wait",
				description: "Waits for host process",
				parameters: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
			},
		]);
		const started: string[] = [];
		const { deps, outputs } = makeDeps(async command => {
			if (command.type !== "get_state") throw new Error(`unexpected command type: ${command.type}`);
			started.push(command.id ?? "");
			await tool.execute(`toolu_${command.id}`, {});
			return {
				id: command.id,
				type: "response",
				command: "get_state",
				success: true,
				data: { agentInvoked: true },
			} as unknown as RpcResponse;
		});
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "active", type: "get_state" });
		dispatcher.dispatch({ id: "queued", type: "get_state" });
		await flushMicrotasks();
		expect(started).toEqual(["active"]);
		expect(hostToolFrames).toHaveLength(1);
		expect(hostToolFrames[0]).toMatchObject({
			type: "host_tool_call",
			toolCallId: "toolu_active",
			toolName: "host_wait",
			arguments: {},
		});

		bridge.close(disconnectMessage);
		await dispatcher.drain();

		expect(started).toEqual(["active", "queued"]);
		expect(hostToolFrames).toHaveLength(1);
		expect(outputs).toEqual([
			{
				id: "active",
				type: "response",
				command: "get_state",
				success: false,
				error: disconnectMessage,
			},
			{
				id: "queued",
				type: "response",
				command: "get_state",
				success: false,
				error: disconnectMessage,
			},
		]);
	});

	test("drain after EOF rejects active and future extension UI requests", async () => {
		const disconnectMessage = "RPC client disconnected before extension UI response completed";
		const pendingExtensionRequests = new RpcPendingExtensionRequests();
		const started: string[] = [];
		const { deps, outputs } = makeDeps(
			async command => {
				if (command.type !== "get_state") throw new Error(`unexpected command type: ${command.type}`);
				started.push(command.id ?? "");
				await requestExtensionInput(depsRef, `${command.id}-dialog`, `${command.id} dialog`);
				return {
					id: command.id,
					type: "response",
					command: "get_state",
					success: true,
					data: { agentInvoked: true },
				} as unknown as RpcResponse;
			},
			{ pendingExtensionRequests },
		);
		const depsRef = deps;
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "active", type: "get_state" });
		dispatcher.dispatch({ id: "queued", type: "get_state" });
		await flushMicrotasks();
		expect(started).toEqual(["active"]);
		expect(outputs).toEqual([
			{
				type: "extension_ui_request",
				id: "active-dialog",
				method: "input",
				message: "active dialog",
			},
		]);

		pendingExtensionRequests.rejectAll(disconnectMessage);
		await dispatcher.drain();

		expect(started).toEqual(["active", "queued"]);
		expect(outputs).toEqual([
			{
				type: "extension_ui_request",
				id: "active-dialog",
				method: "input",
				message: "active dialog",
			},
			{
				id: "active",
				type: "response",
				command: "get_state",
				success: false,
				error: disconnectMessage,
			},
			{
				type: "extension_ui_request",
				id: "queued-dialog",
				method: "input",
				message: "queued dialog",
			},
			{
				id: "queued",
				type: "response",
				command: "get_state",
				success: false,
				error: disconnectMessage,
			},
		]);
	});

	test("a prompt blocked on admission does not hold up abort (RPC queue must keep flowing during vision preprocessing)", async () => {
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const mock = createMockModel({ responses: [{ content: ["should not run before release"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry,
		});

		try {
			// Real vision/preprocessing seam already used elsewhere (see
			// agent-session-aside-delivery.test.ts): gate normalizeModelContextImages
			// so admission spans real (simulated) wall-clock time, exactly like a slow
			// vision-model description call for a text-only model.
			const normalizeStarted = Promise.withResolvers<void>();
			const releaseNormalize = Promise.withResolvers<void>();
			const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
				normalizeStarted.resolve();
				await releaseNormalize.promise;
				return images;
			});

			let trackedPromptTask: Promise<void> | undefined;
			const handleCommand: RpcInputFrameDeps["handleCommand"] = async command => {
				if (command.type === "prompt") {
					// Mirrors the real RPC "prompt" handler: the response is held until
					// the message is admitted (or settles without ever being admitted).
					const admitted = Promise.withResolvers<void>();
					const settled = session.prompt(command.message, { onPromptAdmitted: admitted.resolve }).catch(() => {});
					await Promise.race([admitted.promise, settled]);
					return { id: command.id, type: "response", command: "prompt", success: true };
				}
				if (command.type === "abort") {
					await session.abort({ reason: "user-interrupt" });
					return { id: command.id, type: "response", command: "abort", success: true };
				}
				throw new Error(`unexpected command type: ${command.type}`);
			};
			const { deps, outputs } = makeDeps(handleCommand);
			deps.trackBackgroundTask = task => {
				trackedPromptTask = task;
			};
			const dispatcher = new RpcInputDispatcher({ deps });

			dispatcher.dispatch({ id: "p1", type: "prompt", message: "go while normalizing" });
			await normalizeStarted.promise;
			expect(trackedPromptTask).toBeInstanceOf(Promise);
			expect(outputs).toHaveLength(0);

			dispatcher.dispatch({ id: "a1", type: "abort" });
			// Bounded poll (not a fixed-duration guess): before the fix, `prompt`
			// serializes through the same tail chain as `abort`, so `abort` never
			// starts while normalization is gated — this loop would exhaust without
			// `outputs` ever gaining the abort response.
			for (let i = 0; i < 50 && outputs.length === 0; i++) {
				await flushMicrotasks();
			}
			expect(outputs).toEqual([{ id: "a1", type: "response", command: "abort", success: true }]);

			releaseNormalize.resolve();
			await trackedPromptTask;
			expect(outputs).toContainEqual({ id: "p1", type: "response", command: "prompt", success: true });

			normalizeSpy.mockRestore();
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});

describe("RpcShutdownCoordinator", () => {
	/** performShutdown spy that records call count and outputs.length at the moment it ran. */
	const makeShutdownRecorder = (outputs: OutputFrame[]) => {
		const state = { calls: 0, outputsAtShutdown: -1 };
		const performShutdown = async () => {
			state.calls++;
			state.outputsAtShutdown = outputs.length;
		};
		return { state, performShutdown };
	};

	/**
	 * Full production-shaped harness: a background-dispatched bash frame whose
	 * handler blocks on a gate, tracked by the coordinator exactly as
	 * `runRpcMode` wires it (`trackBackgroundTask: task => coordinator.track(task)`).
	 */
	const makeBashHarness = () => {
		const gate = Promise.withResolvers<RpcResponse>();
		const { deps, outputs } = makeDeps(async command => {
			if (command.type === "bash") return await gate.promise;
			throw new Error(`unexpected: ${command.type}`);
		});
		const shutdown = { requested: false };
		const recorder = makeShutdownRecorder(outputs);
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => shutdown.requested,
			performShutdown: recorder.performShutdown,
		});
		deps.trackBackgroundTask = task => coordinator.track(task);
		return { gate, deps, outputs, shutdown, recorder, coordinator };
	};

	test("deferred shutdown drains an in-flight background bash before performShutdown", async () => {
		const { gate, deps, outputs, shutdown, recorder, coordinator } = makeBashHarness();

		const awaited = dispatchRpcInputFrame({ id: "s1", type: "bash", command: "sleep 9999" }, deps);
		expect(awaited).toBeUndefined();

		// Extension calls pi.shutdown() while bash is in flight; the input loop
		// re-checks after its next serially-awaited frame.
		shutdown.requested = true;
		const check = coordinator.checkShutdownRequested();

		// The check must stay pending while the background bash still owes its
		// response frame. Race it against a flushed sentinel: if the check could
		// resolve, its microtask would win before the setImmediate tick.
		const winner = await Promise.race([check.then(() => "shutdown"), flushMicrotasks().then(() => "pending")]);
		expect(winner).toBe("pending");
		expect(recorder.state.calls).toBe(0);
		expect(outputs).toHaveLength(0);

		gate.resolve(cancelledBashResponse("s1"));
		await check;

		expect(outputs).toEqual([cancelledBashResponse("s1")]);
		expect(recorder.state.calls).toBe(1);
		// The bash response frame was already written when performShutdown ran.
		expect(recorder.state.outputsAtShutdown).toBe(1);
	});

	test("settle hook fires the deferred shutdown when no further client frames arrive", async () => {
		const { gate, deps, outputs, shutdown, recorder } = makeBashHarness();

		const awaited = dispatchRpcInputFrame({ id: "s2", type: "bash", command: "sleep 9999" }, deps);
		expect(awaited).toBeUndefined();

		// Shutdown requested mid-bash; the stdin loop is parked with no frames,
		// so the test never calls checkShutdownRequested() — only track()'s
		// settle hook can trigger it.
		shutdown.requested = true;
		await flushMicrotasks();
		expect(recorder.state.calls).toBe(0);

		gate.resolve(cancelledBashResponse("s2"));
		await flushMicrotasks();
		await flushMicrotasks();

		expect(recorder.state.calls).toBe(1);
		expect(outputs).toEqual([cancelledBashResponse("s2")]);
		expect(recorder.state.outputsAtShutdown).toBe(1);
	});

	test("concurrent triggers are latched: performShutdown runs exactly once", async () => {
		const outputs: OutputFrame[] = [];
		const recorder = makeShutdownRecorder(outputs);
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => true,
			performShutdown: recorder.performShutdown,
		});

		const gateA = Promise.withResolvers<void>();
		const gateB = Promise.withResolvers<void>();
		coordinator.track(gateA.promise);
		coordinator.track(gateB.promise);

		// Explicit trigger (input loop) races the settle hooks of both tasks.
		const check = coordinator.checkShutdownRequested();
		gateA.resolve();
		gateB.resolve();
		await check;
		await flushMicrotasks();
		await flushMicrotasks();

		expect(recorder.state.calls).toBe(1);
		// A later re-check reuses the latched sequence instead of re-running it.
		await coordinator.checkShutdownRequested();
		expect(recorder.state.calls).toBe(1);
	});

	test("no-op when shutdown was not requested", async () => {
		const outputs: OutputFrame[] = [];
		const recorder = makeShutdownRecorder(outputs);
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => false,
			performShutdown: recorder.performShutdown,
		});

		await coordinator.checkShutdownRequested();
		expect(recorder.state.calls).toBe(0);

		// A tracked task settling with the flag false never triggers shutdown.
		const gate = Promise.withResolvers<void>();
		coordinator.track(gate.promise);
		gate.resolve();
		await flushMicrotasks();
		await flushMicrotasks();
		expect(recorder.state.calls).toBe(0);
	});

	test("drain() waits for tasks tracked while draining", async () => {
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => false,
			performShutdown: async () => {},
		});

		const gateA = Promise.withResolvers<void>();
		const gateB = Promise.withResolvers<void>();
		coordinator.track(gateA.promise);
		// When A settles, a new task B enters the set mid-drain.
		void gateA.promise.then(() => {
			coordinator.track(gateB.promise);
		});

		let drained = false;
		const drain = coordinator.drain().then(() => {
			drained = true;
		});

		gateA.resolve();
		await flushMicrotasks();
		// A settled and B was tracked mid-drain; drain must keep waiting on B.
		expect(drained).toBe(false);

		gateB.resolve();
		await drain;
		expect(drained).toBe(true);
	});
});

describe("host-owned account routing over JSONL", () => {
	const NOW = 1_800_000_000_000;
	const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
	type Frame = Record<string, unknown> & { type: string };

	/** A synthetic host wired to a real JSONL pipe: frames the process writes are decoded by the host hook,
	 * and the host's replies travel as stdin lines through `readRpcInputFrames` into the real dispatcher. */
	async function fixture(
		options: { completeCoverage?: boolean; launch?: "model" | "metadata"; unmarked?: boolean } = {},
	) {
		let clock = NOW;
		const usageRequests: string[] = [];
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const authStorage = new AuthStorage(store, {
			routingClock: () => clock,
			usageFetch: (async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				usageRequests.push(`${new Headers(init?.headers).get("authorization")} ${url}`);
				if (!url.startsWith(USAGE_URL)) return new Response("{}", { status: 404 });
				const heavy = new Headers(init?.headers).get("authorization")?.endsWith("-b");
				const reset = new Date(NOW + 3_600_000).toISOString();
				const weekReset = new Date(NOW + 86_400_000).toISOString();
				return new Response(
					JSON.stringify({
						five_hour: { utilization: heavy ? 50 : 10, resets_at: reset },
						seven_day: { utilization: heavy ? 60 : 20, resets_at: weekReset },
						spend: { enabled: false },
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}) as unknown as typeof fetch,
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await authStorage.credentials.set(
			"anthropic",
			["a", "b"].map(suffix => ({
				type: "oauth" as const,
				access: `sk-ant-oat01-${suffix}`,
				refresh: `refresh-${suffix}`,
				expires: NOW + 3_600_000,
				accountId: `acc-${suffix}`,
				email: `${suffix}@example.com`,
			})),
		);
		const identity = authStorage.credentials.routingIdentities({ provider: "anthropic" });
		if (identity.source.status !== "supported") throw new Error("expected a namespace");
		const namespace = identity.source.storeNamespace;
		const refs = Object.fromEntries(
			identity.accounts.map(account => [account.accountId?.replace("acc-", "") ?? "", account.ref]),
		) as Record<string, { storeNamespace: string; nativeRowId: number }>;

		const adapter = options.unmarked
			? undefined
			: new ManagedAccountRoutingAdapter(options.launch ?? "model", {
					completeCoverage: options.completeCoverage ?? true,
					now: () => clock,
				});
		adapter?.bindAuthStorage(authStorage);

		const frames: Frame[] = [];
		let onFrame: (frame: Frame) => void = () => {};
		const serialGate = Promise.withResolvers<void>();
		const stdin = new TransformStream<Uint8Array, Uint8Array>();
		const writer = stdin.writable.getWriter();
		const encoder = new TextEncoder();
		const { deps } = makeDeps(async command => {
			if (command.type === "get_state") await serialGate.promise;
			return { id: command.id, type: "response", command: command.type, success: true } as RpcResponse;
		});
		deps.output = obj => {
			const frame = obj as Frame;
			frames.push(frame);
			onFrame(frame);
		};
		deps.accountRouting = adapter;
		adapter?.attachSink(frame => deps.output(frame));
		const dispatcher = new RpcInputDispatcher({ deps });
		const reading = readRpcInputFrames(
			stdin.readable,
			parsed => dispatcher.dispatch(parsed),
			message => frames.push({ type: "parse_error", message }),
		);
		const send = async (frame: object): Promise<void> => {
			await writer.write(encoder.encode(`${JSON.stringify(frame)}\n`));
			await flushMicrotasks();
			await flushMicrotasks();
		};
		const configure = (extra: Record<string, unknown> = {}) =>
			send({
				id: "cfg",
				type: "account.routing.configure",
				version: 1,
				hostEpoch: "epoch-1",
				runtimeInstanceId: "rt-1",
				scope: "host-owned",
				provider: "anthropic",
				includedOnly: true,
				...extra,
			});
		const ofType = (type: string): Frame[] => frames.filter(frame => frame.type === type);
		const responseFor = (id: string): Frame | undefined =>
			frames.find(frame => frame.type === "response" && frame.id === id);
		const begin = (sessionId = "session-main", signal?: AbortSignal) => {
			if (!adapter) throw new Error("no adapter");
			return adapter.beginCall({
				sessionId,
				modelId: "claude-sonnet-4-5",
				purpose: "agent_turn",
				signal,
				replayPolicy: "no_replay",
			});
		};
		const admit = (request: Frame, accountRef: unknown, admissionId = `adm-${String(request.id)}`) =>
			send({
				type: "account.routing.admit.response",
				id: request.id,
				hostEpoch: request.hostEpoch,
				runtimeInstanceId: request.runtimeInstanceId,
				decision: { kind: "admit", admissionId, accountRef, selectionGeneration: 1, policyRevision: 1 },
			});
		return {
			adapter,
			authStorage,
			refs,
			namespace,
			frames,
			usageRequests,
			dispatcher,
			serialGate,
			send,
			configure,
			ofType,
			responseFor,
			begin,
			admit,
			setHost: (hook: (frame: Frame) => void) => {
				onFrame = hook;
			},
			advance: (ms: number) => {
				clock += ms;
			},
			close: async () => {
				adapter?.dispose();
				serialGate.resolve();
				await writer.close();
				await reading;
				await dispatcher.drain();
				store.close();
			},
		};
	}

	/** Capture a rejection as a value, so a pending call can be asserted after the frame that ends it. */
	const rejection = (promise: Promise<unknown>): Promise<unknown> =>
		promise.then(
			() => undefined,
			(error: unknown) => error,
		);

	const outcomeOf = (overrides: Partial<ManagedAttemptOutcome> = {}): ManagedAttemptOutcome => ({
		startedAt: NOW,
		finishedAt: NOW + 5,
		code: "success",
		dispatch: "dispatched",
		replaySafe: true,
		refusalReason: null,
		retryAfterMs: null,
		quotaBlocks: [],
		windows: [],
		...overrides,
	});

	test("an unmarked independent launch refuses configure and keeps ordinary behavior", async () => {
		const host = await fixture({ unmarked: true });
		await host.configure();
		expect(host.responseFor("cfg")).toMatchObject({ success: false, code: "unsupported_runtime" });
		// Commands outside the family still reach the ordinary handler and never see routing state.
		expect(host.ofType("account.routing.admit.request")).toHaveLength(0);
		await host.close();
	});

	test("a runtime without complete coverage refuses configure and advertises nothing", async () => {
		const host = await fixture({ completeCoverage: false });
		await host.configure();
		expect(host.responseFor("cfg")).toMatchObject({ success: false, code: "unsupported_runtime" });
		expect(host.adapter?.readyCapability()).toBeUndefined();
		expect(host.adapter?.stateProjection()).toBeUndefined();
		await host.close();
	});

	test("a pending-configure call sends nothing, and configure overtakes a blocked serial command", async () => {
		const host = await fixture();
		// A serial command that never finishes: configure must still be answered.
		host.dispatcher.dispatch({ id: "stuck", type: "get_state" });
		const acquiring = host.adapter!.acquire(host.begin(), {});
		await flushMicrotasks();
		expect(host.ofType("account.routing.admit.request")).toHaveLength(0);

		await host.configure();
		expect(host.responseFor("stuck")).toBeUndefined();
		expect(host.responseFor("cfg")).toMatchObject({
			success: true,
			data: {
				version: 1,
				configured: true,
				completeCoverage: true,
				modelDispatch: "allowed",
				accessibleNamespaces: [host.namespace],
			},
		});
		const [request] = host.ofType("account.routing.admit.request");
		expect(request).toMatchObject({
			hostEpoch: "epoch-1",
			runtimeInstanceId: "rt-1",
			provider: "anthropic",
			purpose: "main",
		});
		await host.admit(request!, host.refs.a);
		await expect(acquiring).resolves.toMatchObject({
			accountRef: host.refs.a,
			admissionId: `adm-${String(request!.id)}`,
		});
		await host.close();
	});

	test("admission carries only metadata and each grant reports one started and one outcome", async () => {
		const host = await fixture();
		await host.configure();
		const call = host.begin("session-main");
		const acquiring = host.adapter!.acquire(call, {});
		await flushMicrotasks();
		const [request] = host.ofType("account.routing.admit.request");
		const serialized = JSON.stringify(request);
		expect(serialized).not.toContain("sk-ant-oat01");
		expect(serialized).not.toContain("refresh-");
		expect(request!.catalog).toMatchObject({
			provider: "anthropic",
			storeNamespace: host.namespace,
			runtimeInstanceId: "rt-1",
		});
		await host.admit(request!, host.refs.b);
		const grant = await acquiring;

		host.adapter!.started(grant, NOW + 1);
		host.adapter!.started(grant, NOW + 2);
		// The outcome object may carry extra fields from a buggy caller; only allowlisted ones leave the process.
		const leaky = { ...outcomeOf(), accessToken: "sk-ant-oat01-leak", message: "boom: Bearer sk-ant-oat01-leak" };
		host.adapter!.outcome(grant, leaky as ManagedAttemptOutcome);
		host.adapter!.outcome(grant, outcomeOf({ code: "provider_failed" }));

		expect(host.ofType("account.routing.started")).toHaveLength(1);
		const outcomes = host.ofType("account.routing.outcome");
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({ code: "success", accountRef: host.refs.b, admissionId: grant.admissionId });
		expect(JSON.stringify(outcomes[0])).not.toContain("leak");
		expect(host.adapter!.stateProjection()?.activeAdmissions).toEqual([]);
		await host.close();
	});

	test("a wait pauses the call, a resume overtakes the blocked queue and re-admits with a new correlation id", async () => {
		const host = await fixture();
		await host.configure();
		host.dispatcher.dispatch({ id: "stuck", type: "get_state" });
		const acquiring = host.adapter!.acquire(host.begin(), {});
		await flushMicrotasks();
		const [first] = host.ofType("account.routing.admit.request");
		await host.send({
			type: "account.routing.admit.response",
			id: first!.id,
			hostEpoch: "epoch-1",
			runtimeInstanceId: "rt-1",
			decision: { kind: "wait", waitId: "wait-1", reason: "all_unavailable" },
		});
		expect(host.ofType("account.routing.paused")).toEqual([
			expect.objectContaining({ waitId: "wait-1", reason: "all_unavailable", attemptId: first!.attemptId }),
		]);
		expect(host.adapter!.stateProjection()).toMatchObject({ pausedWaits: ["wait-1"], pendingAdmissions: [] });

		// A resume for an unknown wait, or from another epoch, wakes nothing.
		await host.send({
			type: "account.routing.resume",
			waitId: "nope",
			hostEpoch: "epoch-1",
			runtimeInstanceId: "rt-1",
		});
		await host.send({
			type: "account.routing.resume",
			waitId: "wait-1",
			hostEpoch: "epoch-0",
			runtimeInstanceId: "rt-1",
		});
		expect(host.ofType("account.routing.resumed")).toHaveLength(0);

		await host.send({
			type: "account.routing.resume",
			waitId: "wait-1",
			hostEpoch: "epoch-1",
			runtimeInstanceId: "rt-1",
		});
		expect(host.ofType("account.routing.resumed")).toHaveLength(1);
		const requests = host.ofType("account.routing.admit.request");
		expect(requests).toHaveLength(2);
		expect(requests[1]!.id).not.toBe(first!.id);
		expect(requests[1]).toMatchObject({ previousWaitId: "wait-1", attemptId: first!.attemptId });
		// A resume is a wake hint, not a grant: the call is still waiting for the host's decision.
		await Promise.race([acquiring.then(() => "granted"), flushMicrotasks().then(() => "pending")]).then(state =>
			expect(state).toBe("pending"),
		);
		await host.send({
			type: "account.routing.resume",
			waitId: "wait-1",
			hostEpoch: "epoch-1",
			runtimeInstanceId: "rt-1",
		});
		expect(host.ofType("account.routing.resumed")).toHaveLength(1);

		await host.admit(requests[1]!, host.refs.a);
		await expect(acquiring).resolves.toMatchObject({ accountRef: host.refs.a });
		await host.close();
	});

	test("abort cancels a pending admission and a live wait; late and duplicate responses are ignored", async () => {
		const host = await fixture();
		await host.configure();
		const pendingAbort = new AbortController();
		const pendingRejected = rejection(host.adapter!.acquire(host.begin("s1", pendingAbort.signal), {}));
		await flushMicrotasks();
		const [first] = host.ofType("account.routing.admit.request");
		pendingAbort.abort();
		expect(await pendingRejected).toMatchObject({ code: "cancelled" });
		expect(host.ofType("account.routing.cancel")).toEqual([
			expect.objectContaining({ id: first!.id, operationId: first!.operationId, sessionId: "s1" }),
		]);
		// The host answers after the cancel: nothing resolves, and no grant appears.
		await host.admit(first!, host.refs.a);
		expect(host.adapter!.stateProjection()).toMatchObject({ pendingAdmissions: [], activeAdmissions: [] });

		const waitAbort = new AbortController();
		const waitRejected = rejection(host.adapter!.acquire(host.begin("s2", waitAbort.signal), {}));
		await flushMicrotasks();
		const second = host.ofType("account.routing.admit.request")[1]!;
		await host.send({
			type: "account.routing.admit.response",
			id: second.id,
			hostEpoch: "epoch-1",
			runtimeInstanceId: "rt-1",
			decision: { kind: "wait", waitId: "wait-2", reason: "auto_disabled" },
		});
		waitAbort.abort();
		expect(await waitRejected).toMatchObject({ code: "cancelled" });
		expect(host.ofType("account.routing.cancel")[1]).toMatchObject({ id: second.id, waitId: "wait-2" });
		await host.send({ type: "account.routing.resume", waitId: "wait-2" });
		expect(host.ofType("account.routing.resumed")).toHaveLength(0);
		expect(host.adapter!.stateProjection()?.pausedWaits).toEqual([]);

		// Duplicate and wrong-epoch/instance admit responses for a settled or foreign id change nothing.
		const live = host.adapter!.acquire(host.begin("s3"), {});
		await flushMicrotasks();
		const third = host.ofType("account.routing.admit.request")[2]!;
		const decision = {
			kind: "admit",
			admissionId: "adm-third",
			accountRef: host.refs.a,
			selectionGeneration: 1,
			policyRevision: 1,
		};
		await host.send({
			type: "account.routing.admit.response",
			id: third.id,
			hostEpoch: "epoch-0",
			runtimeInstanceId: "rt-1",
			decision,
		});
		await host.send({
			type: "account.routing.admit.response",
			id: third.id,
			hostEpoch: "epoch-1",
			runtimeInstanceId: "rt-other",
			decision,
		});
		expect(host.adapter!.stateProjection()?.pendingAdmissions).toEqual([third.id as string]);
		await host.send({
			type: "account.routing.admit.response",
			id: third.id,
			hostEpoch: "epoch-1",
			runtimeInstanceId: "rt-1",
			decision,
		});
		await expect(live).resolves.toMatchObject({ admissionId: "adm-third" });
		await host.send({
			type: "account.routing.admit.response",
			id: third.id,
			hostEpoch: "epoch-1",
			runtimeInstanceId: "rt-1",
			decision: { ...decision, admissionId: "adm-dup" },
		});
		expect(host.adapter!.stateProjection()?.activeAdmissions).toEqual(["adm-third"]);
		await host.close();
	});

	test("a host refusal and a malformed decision both end the call closed, never as unmanaged auth", async () => {
		const host = await fixture();
		await host.configure();
		const refused = rejection(host.adapter!.acquire(host.begin(), {}));
		await flushMicrotasks();
		const [first] = host.ofType("account.routing.admit.request");
		await host.send({
			type: "account.routing.admit.response",
			id: first!.id,
			hostEpoch: "epoch-1",
			runtimeInstanceId: "rt-1",
			decision: { kind: "refuse", reason: "quota_blocked" },
		});
		expect(await refused).toMatchObject({ code: "quota_blocked" });

		const malformed = rejection(host.adapter!.acquire(host.begin(), {}));
		await flushMicrotasks();
		const second = host.ofType("account.routing.admit.request")[1]!;
		await host.send({
			type: "account.routing.admit.response",
			id: second.id,
			hostEpoch: "epoch-1",
			runtimeInstanceId: "rt-1",
			decision: { kind: "admit", admissionId: "x", accountRef: { storeNamespace: "not-a-uuid", nativeRowId: 1 } },
		});
		expect(await malformed).toMatchObject({ code: "host_unavailable" });
		await host.close();
	});

	test("a grant whose call is cancelled before its stream starts is released once, by operation id", async () => {
		const host = await fixture();
		await host.configure();
		const abort = new AbortController();
		const call = host.begin("s1", abort.signal);
		const acquiring = host.adapter!.acquire(call, {});
		await flushMicrotasks();
		await host.admit(host.ofType("account.routing.admit.request")[0]!, host.refs.a, "adm-seeded");
		const grant = await acquiring;
		expect(host.adapter!.stateProjection()?.activeAdmissions).toEqual(["adm-seeded"]);

		// The agent loop cancels after pre-resolving, before the stream ever opens.
		abort.abort();
		const released = host.ofType("account.routing.outcome");
		expect(released).toHaveLength(1);
		expect(released[0]).toMatchObject({
			admissionId: "adm-seeded",
			operationId: call.operationId,
			code: "cancelled",
			dispatch: "not_dispatched",
			startedAt: null,
		});
		// Every later path (explicit release, the stream's own settle, session dispose) is a no-op.
		host.adapter!.releaseOperation(call.operationId);
		host.adapter!.outcome(grant, outcomeOf());
		host.adapter!.releaseSession("s1");
		expect(host.ofType("account.routing.outcome")).toHaveLength(1);
		expect(host.adapter!.stateProjection()?.activeAdmissions).toEqual([]);

		// With no abort at all, releaseOperation still settles an unreported grant exactly once.
		const second = host.begin("s2");
		const acquiringSecond = host.adapter!.acquire(second, {});
		await flushMicrotasks();
		await host.admit(host.ofType("account.routing.admit.request")[1]!, host.refs.b, "adm-orphan");
		await acquiringSecond;
		host.adapter!.releaseOperation(second.operationId);
		host.adapter!.releaseOperation(second.operationId);
		expect(host.ofType("account.routing.outcome").filter(frame => frame.admissionId === "adm-orphan")).toHaveLength(
			1,
		);
		await host.close();
	});

	test("abort leaves a dispatched grant to the stream that owns it", async () => {
		const host = await fixture();
		await host.configure();
		const abort = new AbortController();
		const call = host.begin("s1", abort.signal);
		const acquiring = host.adapter!.acquire(call, {});
		await flushMicrotasks();
		await host.admit(host.ofType("account.routing.admit.request")[0]!, host.refs.a, "adm-live");
		const grant = await acquiring;
		host.adapter!.started(grant, NOW + 1);
		abort.abort();
		expect(host.ofType("account.routing.outcome")).toHaveLength(0);
		// The stream settles with what it observed; that outcome is the one the host receives.
		host.adapter!.outcome(grant, outcomeOf({ code: "cancelled", replaySafe: false, dispatch: "replay_unsafe" }));
		expect(host.ofType("account.routing.outcome")).toEqual([
			expect.objectContaining({ admissionId: "adm-live", dispatch: "replay_unsafe", startedAt: NOW }),
		]);
		await host.close();
	});

	test("EOF disposal cancels waits, settles grants and fails closed afterwards", async () => {
		const host = await fixture();
		await host.configure();
		const waiting = rejection(host.adapter!.acquire(host.begin("s1"), {}));
		await flushMicrotasks();
		const [first] = host.ofType("account.routing.admit.request");
		await host.send({
			type: "account.routing.admit.response",
			id: first!.id,
			hostEpoch: "epoch-1",
			runtimeInstanceId: "rt-1",
			decision: { kind: "wait", waitId: "wait-eof", reason: "metadata_pending" },
		});
		const granted = host.adapter!.acquire(host.begin("s2"), {});
		await flushMicrotasks();
		await host.admit(host.ofType("account.routing.admit.request")[1]!, host.refs.a, "adm-eof");
		const grant = await granted;

		host.adapter!.dispose();
		expect(await waiting).toMatchObject({ code: "host_unavailable" });
		expect(host.ofType("account.routing.cancel").some(frame => frame.waitId === "wait-eof")).toBe(true);
		expect(host.ofType("account.routing.outcome")).toEqual([
			expect.objectContaining({ admissionId: "adm-eof", code: "cancelled" }),
		]);
		expect(host.adapter!.isConfigured(grant)).toBe(false);
		// Disconnect never clears the marker into permissive auth: new work is refused, not unmanaged.
		await expect(host.adapter!.acquire(host.begin("s3"), {})).rejects.toBeInstanceOf(ManagedDispatchRefusedError);
		await host.close();
	});

	test("a new epoch ends old admissions, keeps dispatched grants on their old epoch and needs a fresh configure", async () => {
		const host = await fixture();
		await host.configure();
		const granted = host.adapter!.acquire(host.begin("s1"), {});
		await flushMicrotasks();
		await host.admit(host.ofType("account.routing.admit.request")[0]!, host.refs.a, "adm-old");
		const old = await granted;
		const pending = rejection(host.adapter!.acquire(host.begin("s2"), {}));
		await flushMicrotasks();

		// Same epoch, other runtime instance: refused. Same config again: idempotent.
		await host.configure({ id: "other", runtimeInstanceId: "rt-2" });
		expect(host.responseFor("other")).toMatchObject({ success: false, code: "unsupported_runtime" });
		await host.configure({ id: "again" });
		expect(host.responseFor("again")).toMatchObject({ success: true });
		expect(host.adapter!.isConfigured(old)).toBe(true);

		await host.configure({ id: "next", hostEpoch: "epoch-2", runtimeInstanceId: "rt-2" });
		expect(await pending).toMatchObject({ code: "host_unavailable" });
		expect(host.responseFor("next")).toMatchObject({ success: true });
		expect(host.adapter!.isConfigured(old)).toBe(false);
		expect(host.adapter!.stateProjection()).toMatchObject({ hostEpoch: "epoch-2", runtimeInstanceId: "rt-2" });
		// The old grant still reports on its own epoch.
		host.adapter!.outcome(old, outcomeOf());
		expect(host.ofType("account.routing.outcome")[0]).toMatchObject({
			hostEpoch: "epoch-1",
			runtimeInstanceId: "rt-1",
		});
		await host.close();
	});

	test("the metadata launch configures but forbids every model dispatch", async () => {
		const host = await fixture({ launch: "metadata", completeCoverage: false });
		await host.configure();
		expect(host.responseFor("cfg")).toMatchObject({
			success: true,
			data: { completeCoverage: false, modelDispatch: "forbidden", purposes: [] },
		});
		await expect(host.adapter!.acquire(host.begin(), {})).rejects.toMatchObject({ code: "unsupported_runtime" });
		expect(host.ofType("account.routing.admit.request")).toHaveLength(0);
		await host.close();
	});

	test("refresh reads one exact row through the control path; rank is a no-I/O subset ranking with stale and foreign guards", async () => {
		const host = await fixture();
		await host.configure();
		host.dispatcher.dispatch({ id: "stuck", type: "get_state" });
		const base = { hostEpoch: "epoch-1", runtimeInstanceId: "rt-1", modelId: "claude-sonnet-4-5" };
		await host.send({ id: "r1", type: "account.routing.refresh", ...base, accountRef: host.refs.a });
		await Bun.sleep(20);
		const refreshed = host.responseFor("r1");
		expect(refreshed).toMatchObject({ success: true });
		const catalog = (
			refreshed as unknown as {
				data: {
					catalog: { catalogRevision: number; accounts: Array<{ ref: unknown; billing: { state: string } }> };
				};
			}
		).data.catalog;
		expect(catalog.accounts.find(a => JSON.stringify(a.ref) === JSON.stringify(host.refs.a))?.billing.state).toBe(
			"disabled",
		);
		expect(catalog.accounts.find(a => JSON.stringify(a.ref) === JSON.stringify(host.refs.b))?.billing.state).toBe(
			"unknown",
		);
		// Only the refreshed row's own bearer reached the usage endpoint; the sibling was never read.
		expect(host.usageRequests.length).toBeGreaterThan(0);
		expect(host.usageRequests.every(request => request.startsWith("Bearer sk-ant-oat01-a "))).toBe(true);

		// Excluded-highest-anchor: rank only the host's eligible subset. A is the better account overall,
		// but with A excluded the anchor must come from the remaining candidates.
		await host.send({ id: "r2", type: "account.routing.refresh", ...base, accountRef: host.refs.b });
		await Bun.sleep(20);
		const full = (host.responseFor("r2") as unknown as { data: { catalog: { catalogRevision: number } } }).data
			.catalog;
		const both = { ...base, nowMs: NOW, catalogRevision: full.catalogRevision };
		await host.send({ id: "s1", type: "account.routing.rank", ...both, candidateRefs: [host.refs.a, host.refs.b] });
		await host.send({ id: "s2", type: "account.routing.rank", ...both, candidateRefs: [host.refs.b] });
		expect(host.responseFor("s1")).toMatchObject({ success: true, data: { anchorRef: host.refs.a } });
		expect(host.responseFor("s2")).toMatchObject({
			success: true,
			data: { anchorRef: host.refs.b, bestCloseRefs: [host.refs.b] },
		});

		const rankBase = { ...base, nowMs: NOW, catalogRevision: full.catalogRevision };
		const before = host.usageRequests.length;
		await host.send({
			id: "k1",
			type: "account.routing.rank",
			...rankBase,
			candidateRefs: [host.refs.a, host.refs.a],
		});
		expect(host.responseFor("k1")).toMatchObject({
			success: true,
			data: { method: "claude-native-window-pressure-v1", version: 1, catalogRevision: full.catalogRevision },
		});
		expect(host.usageRequests.length).toBe(before);

		await host.send({
			id: "k2",
			type: "account.routing.rank",
			...rankBase,
			catalogRevision: full.catalogRevision + 1,
			candidateRefs: [host.refs.a],
		});
		expect(host.responseFor("k2")).toMatchObject({ success: false, code: "metadata_pending" });
		await host.send({
			id: "k3",
			type: "account.routing.rank",
			...rankBase,
			candidateRefs: [{ storeNamespace: "11111111-1111-4111-8111-111111111111", nativeRowId: 1 }],
		});
		expect(host.responseFor("k3")).toMatchObject({ success: false, code: "source_changed" });
		await host.send({
			id: "k4",
			type: "account.routing.rank",
			...rankBase,
			candidateRefs: [{ ...host.refs.a, nativeRowId: 9999 }],
		});
		expect(host.responseFor("k4")).toMatchObject({ success: false, code: "no_account" });
		await host.send({ id: "k5", type: "account.routing.rank", ...rankBase, candidateRefs: [] });
		expect(host.responseFor("k5")).toMatchObject({ success: false, code: "invalid_request" });
		await host.send({
			id: "k6",
			type: "account.routing.rank",
			...rankBase,
			hostEpoch: "epoch-0",
			candidateRefs: [host.refs.a],
		});
		expect(host.responseFor("k6")).toMatchObject({ success: false, code: "host_unavailable" });
		await host.close();
	});

	test("the launch marker is consumed so tool-spawned processes stay unmarked", () => {
		const env: Record<string, string | undefined> = { OMP_HOST_ACCOUNT_ROUTING: "1", KEEP: "x" };
		expect(consumeHostAccountRoutingMarker(env)).toBe("model");
		expect(env).toEqual({ KEEP: "x" });
		expect(consumeHostAccountRoutingMarker({ OMP_HOST_ACCOUNT_ROUTING: "metadata" })).toBe("metadata");
		expect(consumeHostAccountRoutingMarker({ OMP_HOST_ACCOUNT_ROUTING: "true" })).toBeUndefined();
		expect(consumeHostAccountRoutingMarker({})).toBeUndefined();
	});
});
