/**
 * Goal mode for RPC hosts. `GoalRuntime` owns goal state, persistence, and
 * budget steering; this controller supplies what interactive mode otherwise
 * provides around it: enabling the hidden `goal` tool, restoring a persisted
 * goal on resume, and auto-continuing between turns.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger, stableStringifyJson } from "@oh-my-pi/pi-utils";
import { cfgGoalContinuationModes, cfgGoalEnabled } from "../../goals/settings";
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import type { GoalModeState } from "../../goals/state";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import type { SessionContext } from "../../session/session-context";
import { nextActionableTask } from "../../tools/todo";

export type RpcGoalAction =
	| { action: "set"; objective: string; tokenBudget?: number }
	| { action: "pause" }
	| { action: "resume" }
	| { action: "drop" }
	| { action: "get" };

export type RpcGoalSession = Pick<
	AgentSession,
	| "goalRuntime"
	| "getGoalModeState"
	| "setGoalModeState"
	| "getEnabledToolNames"
	| "setActiveToolsByName"
	| "getTodoPhases"
	| "settings"
	| "isStreaming"
	| "sendGoalModeContext"
	| "promptCustomMessage"
	| "subscribe"
	| "sessionManager"
> & {
	sessionManager: Pick<
		AgentSession["sessionManager"],
		"buildSessionContext" | "appendModeChange" | "appendCustomEntry"
	>;
};

const GOAL_TOOL_NAME = "goal";
const CONTINUATION_DELAY_MS = 800;

export function goalFromModeData(modeData: SessionContext["modeData"]): Goal | undefined {
	const goal = modeData?.goal;
	if (!goal || typeof goal !== "object") return undefined;
	const value = goal as Record<string, unknown>;
	if (
		typeof value.id !== "string" ||
		typeof value.objective !== "string" ||
		typeof value.status !== "string" ||
		typeof value.tokensUsed !== "number" ||
		typeof value.timeUsedSeconds !== "number" ||
		typeof value.createdAt !== "number" ||
		typeof value.updatedAt !== "number"
	) {
		return undefined;
	}
	return {
		id: value.id,
		objective: value.objective,
		status: value.status as Goal["status"],
		tokenBudget: typeof value.tokenBudget === "number" ? value.tokenBudget : undefined,
		tokensUsed: value.tokensUsed,
		timeUsedSeconds: value.timeUsedSeconds,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

export class RpcGoalController {
	readonly #session: RpcGoalSession;
	#previousTools: string[] | undefined;
	#continuationTimer: ReturnType<typeof setTimeout> | undefined;
	#pendingContinuationTurns = 0;
	#previousContinuationActivity: string | undefined;
	#suppressNextContinuation = false;
	#unsubscribe: (() => void) | undefined;

	constructor(session: RpcGoalSession) {
		this.#session = session;
	}

	attach(): void {
		this.#unsubscribe ??= this.#session.subscribe(event => {
			void this.#handleSessionEvent(event);
		});
	}

	dispose(): void {
		this.#cancelContinuation();
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	get state(): GoalModeState | undefined {
		return this.#session.getGoalModeState();
	}

	async handle(command: RpcGoalAction): Promise<GoalModeState | undefined> {
		if (!cfgGoalEnabled.get(this.#session.settings)) {
			throw new Error("Goal mode is disabled. Enable it in settings (goal.enabled).");
		}
		switch (command.action) {
			case "get":
				return this.state;
			case "set": {
				const objective = command.objective.trim();
				if (!objective) throw new Error("Goal objective is required.");
				const existing = this.state;
				const input = { objective, tokenBudget: command.tokenBudget };
				if (existing?.goal.status === "active" || existing?.goal.status === "paused") {
					const state = await this.#session.goalRuntime.replaceGoal(input);
					await this.#enableGoalTool();
					await this.#afterActivate(state);
					return state;
				}
				const state = await this.#session.goalRuntime.createGoal(input);
				await this.#enableGoalTool();
				await this.#afterActivate(state);
				return state;
			}
			case "resume": {
				const existing = this.state;
				if (!existing || existing.goal.status !== "paused") {
					throw new Error("No paused goal to resume.");
				}
				const state = await this.#session.goalRuntime.resumeGoal();
				await this.#enableGoalTool();
				await this.#afterActivate(state);
				return state;
			}
			case "pause": {
				if (this.state?.goal.status !== "active") throw new Error("No active goal to pause.");
				this.#cancelContinuation();
				return await this.#session.goalRuntime.pauseGoal();
			}
			case "drop": {
				if (!this.state) throw new Error("No goal to drop.");
				this.#cancelContinuation();
				await this.#session.goalRuntime.dropGoal();
				await this.#restoreTools();
				return undefined;
			}
			default: {
				const unknown: never = command;
				throw new Error(`Unknown goal action: ${String((unknown as { action?: unknown }).action)}`);
			}
		}
	}

	/** Re-arm a goal persisted on the current session branch (startup, switch, branch). */
	async restoreFromSession(): Promise<void> {
		this.#cancelContinuation();
		this.#resetSuppression();
		const context = this.#session.sessionManager.buildSessionContext();
		if (context.mode !== "goal" && context.mode !== "goal_paused") {
			this.#session.goalRuntime.clearAccounting();
			this.#session.setGoalModeState(undefined);
			this.#previousTools = undefined;
			return;
		}
		if (!cfgGoalEnabled.get(this.#session.settings)) {
			this.#session.goalRuntime.clearAccounting();
			this.#session.sessionManager.appendModeChange("none");
			return;
		}
		const goal = goalFromModeData(context.modeData);
		if (!goal) {
			this.#session.sessionManager.appendModeChange("none");
			return;
		}
		this.#session.setGoalModeState({ enabled: context.mode === "goal", mode: "active", goal });
		const restored = await this.#session.goalRuntime.onThreadResumed();
		// sdk.ts excludes "goal" from the initial tool set; re-add it so the
		// agent can resume, complete, or drop the restored goal.
		if (restored?.goal) await this.#enableGoalTool();
	}

	async #afterActivate(state: GoalModeState): Promise<void> {
		this.#session.setGoalModeState(state);
		this.#resetSuppression();
		if (this.#session.isStreaming) {
			await this.#session.sendGoalModeContext({ deliverAs: "steer" });
		} else {
			this.#scheduleContinuation();
		}
	}

	async #enableGoalTool(): Promise<void> {
		const previousTools = this.#session.getEnabledToolNames().filter(name => name !== GOAL_TOOL_NAME);
		this.#previousTools ??= previousTools;
		if (this.#session.getEnabledToolNames().includes(GOAL_TOOL_NAME)) return;
		await this.#session.setActiveToolsByName([...new Set([...previousTools, GOAL_TOOL_NAME])]);
	}

	async #restoreTools(): Promise<void> {
		const previousTools = this.#previousTools;
		this.#previousTools = undefined;
		if (previousTools) await this.#session.setActiveToolsByName(previousTools);
	}

	async #handleSessionEvent(event: AgentSessionEvent): Promise<void> {
		try {
			if (event.type === "agent_start") {
				this.#cancelContinuation();
				return;
			}
			if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic) {
				this.#resetSuppression();
				return;
			}
			if (event.type === "goal_updated") {
				if (event.state?.goal?.status === "dropped") {
					this.#cancelContinuation();
					await this.#restoreTools();
					return;
				}
				if (!event.state?.enabled) this.#cancelContinuation();
				return;
			}
			if (event.type !== "agent_end") return;
			if (this.#pendingContinuationTurns > 0) {
				this.#pendingContinuationTurns--;
				const activity = continuationActivity(event.messages);
				this.#suppressNextContinuation = activity.length === 0 || activity === this.#previousContinuationActivity;
				this.#previousContinuationActivity = activity;
			} else {
				this.#resetSuppression();
			}
			const state = this.state;
			if (state?.mode === "exiting") {
				await this.#restoreTools();
				this.#session.setGoalModeState(undefined);
				this.#session.sessionManager.appendModeChange("none");
				this.#session.sessionManager.appendCustomEntry("goal-completed", {
					objective: state.goal.objective,
					tokensUsed: state.goal.tokensUsed,
					tokenBudget: state.goal.tokenBudget,
					timeUsedSeconds: state.goal.timeUsedSeconds,
				});
				this.#cancelContinuation();
				return;
			}
			this.#scheduleContinuation();
		} catch (error) {
			logger.warn("RPC goal event handling failed", { error: String(error) });
		}
	}

	#scheduleContinuation(): void {
		this.#cancelContinuation();
		if (!cfgGoalContinuationModes.get(this.#session.settings).includes("rpc")) return;
		if (this.#suppressNextContinuation) return;
		if (this.#openWorkAllBlocked()) return;
		const state = this.state;
		if (!state?.enabled || state.goal.status !== "active") return;
		const prompt = this.#session.goalRuntime.buildContinuationPrompt();
		if (!prompt) return;
		this.#continuationTimer = setTimeout(() => {
			this.#continuationTimer = undefined;
			const latest = this.state;
			if (!latest?.enabled || latest.goal.status !== "active") return;
			if (this.#session.isStreaming) return;
			if (this.#openWorkAllBlocked()) return;
			this.#pendingContinuationTurns++;
			void this.#session
				.promptCustomMessage({
					customType: "goal-continuation",
					content: prompt,
					display: false,
					attribution: "agent",
				})
				.then(admitted => {
					if (!admitted) this.#pendingContinuationTurns = Math.max(0, this.#pendingContinuationTurns - 1);
				})
				.catch(error => {
					this.#pendingContinuationTurns = Math.max(0, this.#pendingContinuationTurns - 1);
					logger.warn("RPC goal continuation failed", { error: String(error) });
				});
		}, CONTINUATION_DELAY_MS);
	}

	/** A blocked-only todo list has no work the agent can advance without another turn. */
	#openWorkAllBlocked(): boolean {
		const phases = this.#session.getTodoPhases();
		if (nextActionableTask(phases)) return false;
		for (const phase of phases) {
			for (const task of phase.tasks) {
				if (task.status === "blocked") return true;
			}
		}
		return false;
	}

	#cancelContinuation(): void {
		if (this.#continuationTimer) {
			clearTimeout(this.#continuationTimer);
			this.#continuationTimer = undefined;
		}
	}

	#resetSuppression(): void {
		this.#pendingContinuationTurns = 0;
		this.#previousContinuationActivity = undefined;
		this.#suppressNextContinuation = false;
	}
}

/** Digest of tool activity in a turn; identical consecutive digests mean the agent is looping. */
function continuationActivity(messages: AgentMessage[]): string {
	const digests: string[] = [];
	const record = (value: unknown): void => {
		const serialized = stableStringifyJson(value);
		digests.push(`${serialized.length}:${Bun.hash(serialized).toString(16)}`);
	};
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") record(["call", block.name, block.arguments]);
			}
		} else if (message.role === "toolResult") {
			record(["result", message.toolName, message.content, message.isError === true]);
		}
	}
	return digests.join("|");
}
