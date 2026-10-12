/**
 * Host-owned Claude account routing for the owned RPC runtime.
 *
 * A host (Paseo) launches OMP with `OMP_HOST_ACCOUNT_ROUTING` set. That puts routing into
 * pending-configure: no managed model call leaves until the host sends `account.routing.configure`.
 * From then on every Claude model call asks the host which native account serves it
 * (`account.routing.admit.request`), waits when told to, and reports exactly one outcome per grant.
 * Credentials never cross JSONL; only account refs and allowlisted metadata do.
 *
 * {@link ManagedAccountRoutingAdapter} is the {@link ManagedRoutingDriver} the native stream and auth
 * paths consume, and the {@link ManagedAttemptLifecycle} the strict resolver reports through.
 */
import { dlopen, FFIType } from "bun:ffi";
import { logger } from "@oh-my-pi/pi-utils";
import type { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { ManagedDispatchRefusedError, undispatchedOutcome } from "@oh-my-pi/pi-ai/auth-retry";
import {
	type RoutingAccountRankInput,
	type RoutingQuotaBlock,
	type RoutingRank,
	rankRoutingCandidates,
} from "@oh-my-pi/pi-ai/auth/rank";
import type { ManagedAttemptLifecycle } from "@oh-my-pi/pi-ai/auth/routing";
import {
	type AccountRef,
	isStoreNamespace,
	type ManagedAdmissionGrant,
	type ManagedAttemptOutcome,
	type ManagedCallContext,
	type ManagedReplayPolicy,
	type ManagedRoutingDriver,
	ROUTING_REFUSAL_CODES,
	type RoutingIdentityCatalog,
	type RoutingRefusalCode,
} from "@oh-my-pi/pi-ai/auth/types";
import {
	currentIncludedBilling,
	type IncludedBillingState,
	readRoutingObservation,
	type RoutingObservation,
	type RoutingWindow,
	unknownBilling,
} from "@oh-my-pi/pi-ai/usage";
import { DEFAULT_CLAUDE_API_BASE_URL } from "@oh-my-pi/pi-ai/usage/claude-api";
import { MANAGED_ROUTING_COMPLETE_COVERAGE } from "../../cli/account-routing-capabilities-cli";
import type {
	RpcAccountRef,
	RpcAccountRoutingAdmitRequest,
	RpcAccountRoutingCancel,
	RpcAccountRoutingCommand,
	RpcAccountRoutingConfigureData,
	RpcAccountRoutingDecision,
	RpcAccountRoutingEvent,
	RpcAccountRoutingOutcome,
	RpcAccountRoutingRankData,
	RpcAccountRoutingResponse,
	RpcAccountRoutingStarted,
	RpcAccountRoutingState,
	RpcRoutingAccount,
	RpcRoutingCatalog,
	RpcRoutingPurpose,
} from "./rpc-types";

export { MANAGED_ROUTING_COMPLETE_COVERAGE };

/** Launch marker the managed host sets before process start; consumed (removed) at RPC startup. */
export const HOST_ACCOUNT_ROUTING_ENV = "OMP_HOST_ACCOUNT_ROUTING";

/** `model`: normal owned launch. `metadata`: discovery only, model dispatch forbidden. */
export type HostAccountRoutingLaunch = "model" | "metadata";

export const ROUTING_PURPOSES: readonly RpcRoutingPurpose[] = [
	"main",
	"subagent",
	"advisor",
	"title",
	"compaction",
	"memory",
	"vision",
	"repair",
	"eval",
	"judgment",
	"other_auxiliary",
];

const WAIT_REASONS: ReadonlySet<string> = new Set(["metadata_pending", "all_unavailable", "auto_disabled"]);
const REFUSAL_CODES: ReadonlySet<string> = new Set(ROUTING_REFUSAL_CODES);
const FRAME_BACKLOG_LIMIT = 1024;

/**
 * Remove a variable from the real process environment. Bun's `delete process.env.X` only edits its own
 * copy; the embedded native shell and any native spawn read the libc environment, so the marker would
 * still reach tool-spawned processes. Best effort: a platform where the call is unavailable keeps the
 * JS-side removal and logs the gap.
 */
function unsetNativeEnvironment(name: string): void {
	try {
		const key = Buffer.from(`${name}\0`);
		if (process.platform === "win32") {
			const lib = dlopen("kernel32.dll", {
				SetEnvironmentVariableA: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
			});
			lib.symbols.SetEnvironmentVariableA(key, null);
		} else {
			const lib = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
				unsetenv: { args: [FFIType.cstring], returns: FFIType.i32 },
			});
			lib.symbols.unsetenv(key);
		}
	} catch (error) {
		logger.warn("Could not clear the host account-routing marker from the native environment", {
			error: String(error),
		});
	}
}

/**
 * Read and remove the launch marker. Removal happens before any child tool process can inherit it,
 * so a terminal or `omp` spawned by a tool stays an independent, unmarked launch.
 *
 * @param env Pass an explicit map in tests; the default also clears the native process environment.
 */
export function consumeHostAccountRoutingMarker(
	env?: Record<string, string | undefined>,
): HostAccountRoutingLaunch | undefined {
	const target = env ?? process.env;
	const value = target[HOST_ACCOUNT_ROUTING_ENV];
	if (value === undefined) return undefined;
	delete target[HOST_ACCOUNT_ROUTING_ENV];
	if (!env) unsetNativeEnvironment(HOST_ACCOUNT_ROUTING_ENV);
	return value === "1" ? "model" : value === "metadata" ? "metadata" : undefined;
}

/** Whether a stdin frame belongs to the account-routing family. */
export function isAccountRoutingFrame(value: unknown): value is { type: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string" &&
		(value as { type: string }).type.startsWith("account.routing.")
	);
}

type FrameSink = (frame: RpcAccountRoutingEvent) => void;

interface PendingRequest {
	kind: "request";
	correlationId: string;
	attemptId: string;
	settle: (decision: RpcAccountRoutingDecision) => void;
}

interface PendingWait {
	kind: "wait";
	correlationId: string;
	attemptId: string;
	waitId: string;
	settle: () => void;
}

interface CallRecord {
	call: ManagedCallContext;
	grants: Map<string, GrantRecord>;
	pending: PendingRequest | PendingWait | undefined;
	rejectPending: ((error: ManagedDispatchRefusedError) => void) | undefined;
	/** Row of the previous grant, so a forced refresh only targets the row the host grants again. */
	previousRef: AccountRef | undefined;
	lastRef: AccountRef | undefined;
	detach: (() => void) | undefined;
}

interface GrantRecord {
	grant: ManagedAdmissionGrant;
	call: CallRecord;
	startedAt: number | null;
}

interface ActiveConfig {
	hostEpoch: string;
	runtimeInstanceId: string;
}

export interface ManagedAccountRoutingOptions {
	/** Test seam. Production reads {@link MANAGED_ROUTING_COMPLETE_COVERAGE}. */
	completeCoverage?: boolean;
	now?: () => number;
}

/** Typed command failure: allowlisted code, fixed message. */
export class AccountRoutingCommandError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.name = "AccountRoutingCommandError";
		this.code = code;
	}
}

const refusal = (code: RoutingRefusalCode, retryAfterMs: number | null = null): ManagedDispatchRefusedError =>
	new ManagedDispatchRefusedError(code, retryAfterMs);

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isRecordLike = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function parseAccountRef(raw: unknown): AccountRef | undefined {
	if (!isRecordLike(raw)) return undefined;
	const { storeNamespace, nativeRowId } = raw;
	if (!isStoreNamespace(storeNamespace)) return undefined;
	if (typeof nativeRowId !== "number" || !Number.isSafeInteger(nativeRowId) || nativeRowId < 1) return undefined;
	return { storeNamespace, nativeRowId };
}

const refKey = (ref: AccountRef): string => `${ref.storeNamespace}:${ref.nativeRowId}`;
const sameRef = (a: AccountRef | undefined, b: AccountRef | undefined): boolean =>
	a !== undefined && b !== undefined && refKey(a) === refKey(b);

function normalizePurpose(purpose: string): RpcRoutingPurpose {
	if (purpose === "agent_turn") return "main";
	return (ROUTING_PURPOSES as readonly string[]).includes(purpose)
		? (purpose as RpcRoutingPurpose)
		: "other_auxiliary";
}

function parseDecision(raw: unknown): RpcAccountRoutingDecision | undefined {
	if (!isRecordLike(raw)) return undefined;
	if (raw.kind === "admit") {
		const accountRef = parseAccountRef(raw.accountRef);
		const { admissionId, selectionGeneration, policyRevision } = raw;
		if (
			!accountRef ||
			!isNonEmptyString(admissionId) ||
			typeof selectionGeneration !== "number" ||
			!Number.isSafeInteger(selectionGeneration) ||
			selectionGeneration < 0 ||
			typeof policyRevision !== "number" ||
			!Number.isSafeInteger(policyRevision) ||
			policyRevision < 0
		) {
			return undefined;
		}
		return { kind: "admit", admissionId, accountRef, selectionGeneration, policyRevision };
	}
	if (raw.kind === "wait") {
		const { waitId, reason, reconsiderAt } = raw;
		if (!isNonEmptyString(waitId) || typeof reason !== "string") return undefined;
		if (!WAIT_REASONS.has(reason) && !REFUSAL_CODES.has(reason)) return undefined;
		return {
			kind: "wait",
			waitId,
			reason,
			...(typeof reconsiderAt === "number" && Number.isFinite(reconsiderAt) ? { reconsiderAt } : {}),
		};
	}
	if (raw.kind === "refuse") {
		return typeof raw.reason === "string" ? { kind: "refuse", reason: raw.reason } : undefined;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Allowlisted projections. Everything that leaves the process is rebuilt field by field.
// ---------------------------------------------------------------------------

function finiteOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pickScope(scope: RoutingWindow["scope"]): RoutingWindow["scope"] {
	if (scope.kind === "model") return { kind: "model", modelId: String(scope.modelId) };
	if (scope.kind === "family") return { kind: "family", family: String(scope.family) };
	return { kind: "shared" };
}

function pickWindow(window: RoutingWindow): RoutingWindow {
	return {
		id: String(window.id),
		label: String(window.label),
		scope: pickScope(window.scope),
		usedFraction: finiteOrNull(window.usedFraction),
		resetAt: finiteOrNull(window.resetAt),
		observedAt: finiteOrNull(window.observedAt),
		validUntil: finiteOrNull(window.validUntil),
		source: window.source === "usage-full" || window.source === "usage-header" ? window.source : "unknown",
	};
}

function pickBlock(block: RoutingQuotaBlock): RoutingQuotaBlock {
	return {
		limitId: String(block.limitId),
		scope: pickScope(block.scope),
		resetAt: finiteOrNull(block.resetAt),
		observedAt: finiteOrNull(block.observedAt) ?? 0,
		source: block.source === "native-usage" ? "native-usage" : "provider-rejection",
		confirmed: true,
	};
}

function pickBilling(billing: IncludedBillingState): IncludedBillingState {
	return {
		state: billing.state,
		observedAt: finiteOrNull(billing.observedAt),
		validUntil: finiteOrNull(billing.validUntil),
		source: billing.source,
		sourceRevision: typeof billing.sourceRevision === "string" ? billing.sourceRevision : null,
		...(billing.reason ? { reason: billing.reason } : {}),
	};
}

const blockKey = (block: RoutingQuotaBlock): string => `${block.limitId}\0${JSON.stringify(block.scope)}`;

/** Same account+limit+scope keeps the latest observation; equal-time conflicts keep the more restrictive block. */
function mergeBlock(into: Map<string, RoutingQuotaBlock>, block: RoutingQuotaBlock): void {
	const key = blockKey(block);
	const existing = into.get(key);
	if (!existing || block.observedAt > existing.observedAt) {
		into.set(key, block);
		return;
	}
	if (block.observedAt === existing.observedAt) {
		const reset = (b: RoutingQuotaBlock): number => (b.resetAt === null ? Number.POSITIVE_INFINITY : b.resetAt);
		if (reset(block) > reset(existing)) into.set(key, block);
	}
}

function unknownRank(billing: IncludedBillingState): RoutingRank {
	return {
		method: "claude-native-window-pressure-v1",
		version: 1,
		modelId: null,
		modelFamily: null,
		planGateApplies: false,
		planEligibility: "unknown",
		billingEligibility:
			billing.state === "disabled" ? "eligible" : billing.state === "enabled" ? "enabled" : "unknown",
		applicableLimitIds: [],
		coverage: "unknown",
		unknownReasons: ["metadata_pending"],
		usageMeasured: false,
		primaryHot: null,
		primaryUsed: null,
		secondaryUsed: null,
		primaryRequiredDrain: null,
		secondaryRequiredDrain: null,
	};
}

interface ProjectedAccount {
	account: Omit<RpcRoutingAccount, "rank">;
	billing: IncludedBillingState;
	windows: RoutingWindow[];
	quotaBlocks: RoutingQuotaBlock[];
}

interface Projection {
	identity: RoutingIdentityCatalog;
	namespace: string;
	accounts: ProjectedAccount[];
}

export class ManagedAccountRoutingAdapter implements ManagedRoutingDriver, ManagedAttemptLifecycle {
	readonly launch: HostAccountRoutingLaunch;
	readonly #completeCoverage: boolean;
	readonly #now: () => number;
	readonly #lifetime = new AbortController();
	#authStorage: AuthStorage | undefined;
	#sink: FrameSink | undefined;
	#backlog: RpcAccountRoutingEvent[] = [];
	#phase: "pending" | "configured" | "disposed" = "pending";
	#config: ActiveConfig | undefined;
	#configured = Promise.withResolvers<void>();
	#generation = 0;
	#correlation = 0;
	#catalogRevision = 0;
	#signature = "";
	readonly #records = new Map<string, CallRecord>();
	readonly #grants = new Map<string, GrantRecord>();
	readonly #requests = new Map<string, { record: CallRecord; pending: PendingRequest }>();
	readonly #waits = new Map<string, { record: CallRecord; pending: PendingWait }>();
	/** Provider-rejection blocks retained until a fresh matching post-reset observation retires them. */
	readonly #providerBlocks = new Map<string, Map<string, RoutingQuotaBlock>>();
	/**
	 * Exact-row refreshes are not written to the shared usage cache, so the adapter keeps the identity-bound
	 * observation it received. A catalog read prefers whichever observation is newer.
	 */
	readonly #refreshed = new Map<string, RoutingObservation>();

	constructor(launch: HostAccountRoutingLaunch, options: ManagedAccountRoutingOptions = {}) {
		this.launch = launch;
		this.#completeCoverage = options.completeCoverage ?? MANAGED_ROUTING_COMPLETE_COVERAGE;
		this.#now = options.now ?? Date.now;
		// A caller that never configures is cancelled through dispose; no unhandled rejection.
		this.#configured.promise.catch(() => {});
	}

	// -- wiring ---------------------------------------------------------------

	/** Bind the native credential source. Idempotent for the same storage; a different one is a wiring bug. */
	bindAuthStorage(authStorage: AuthStorage): void {
		if (this.#authStorage && this.#authStorage !== authStorage) {
			throw new Error("Managed account routing is already bound to a different auth storage");
		}
		this.#authStorage = authStorage;
	}

	get authStorage(): AuthStorage | undefined {
		return this.#authStorage;
	}

	/** Attach the JSONL writer. Frames produced earlier are flushed in order. */
	attachSink(sink: FrameSink): void {
		this.#sink = sink;
		const backlog = this.#backlog;
		this.#backlog = [];
		for (const frame of backlog) sink(frame);
	}

	#emit(frame: RpcAccountRoutingEvent): void {
		if (this.#sink) {
			this.#sink(frame);
		} else if (this.#backlog.length < FRAME_BACKLOG_LIMIT) {
			this.#backlog.push(frame);
		}
	}

	/** Capability advertised in `ready`; undefined until native coverage is complete. */
	readyCapability(): { version: 1; completeCoverage: true; purposes: RpcRoutingPurpose[] } | undefined {
		if (this.launch !== "model" || !this.#completeCoverage) return undefined;
		return { version: 1, completeCoverage: true, purposes: [...ROUTING_PURPOSES] };
	}

	/** `get_state.accountRouting`; omitted for a process that is not configured. */
	stateProjection(): RpcAccountRoutingState | undefined {
		const config = this.#config;
		if (this.#phase !== "configured" || !config) return undefined;
		return {
			version: 1,
			hostEpoch: config.hostEpoch,
			runtimeInstanceId: config.runtimeInstanceId,
			pendingAdmissions: [...this.#requests.keys()],
			pausedWaits: [...this.#waits.keys()],
			activeAdmissions: [...this.#grants.keys()],
		};
	}

	// -- ManagedRoutingDriver -------------------------------------------------

	beginCall(input: {
		sessionId: string;
		modelId: string;
		purpose: string;
		signal?: AbortSignal;
		replayPolicy: ManagedReplayPolicy;
	}): ManagedCallContext {
		const call: ManagedCallContext = {
			operationId: crypto.randomUUID(),
			requestGeneration: ++this.#generation,
			sessionId: input.sessionId,
			modelId: input.modelId,
			purpose: normalizePurpose(input.purpose),
			signal: input.signal,
			replayPolicy: input.replayPolicy,
		};
		const record: CallRecord = {
			call,
			grants: new Map(),
			pending: undefined,
			rejectPending: undefined,
			previousRef: undefined,
			lastRef: undefined,
			detach: undefined,
		};
		if (this.#phase === "disposed") return call;
		this.#records.set(call.operationId, record);
		const signal = input.signal;
		if (signal) {
			if (signal.aborted) {
				this.#abandon(record, "cancelled", false);
			} else {
				const onAbort = (): void => this.#abandon(record, "cancelled", false);
				signal.addEventListener("abort", onAbort, { once: true });
				record.detach = () => signal.removeEventListener("abort", onAbort);
			}
		}
		return call;
	}

	async acquire(
		call: ManagedCallContext,
		_options: { previousOutcome?: ManagedAttemptOutcome; forceRefresh?: boolean },
	): Promise<ManagedAdmissionGrant> {
		if (this.launch === "metadata") throw refusal("unsupported_runtime");
		const record = this.#records.get(call.operationId);
		if (!record) throw refusal(this.#phase === "disposed" ? "host_unavailable" : "cancelled");
		const signal = call.signal;
		if (signal?.aborted) throw refusal("cancelled");
		await this.#untilConfigured(record);
		const config = this.#activeConfig();
		const authStorage = this.#authStorage;
		if (!authStorage) throw refusal("unsupported_runtime");
		record.previousRef = record.lastRef;

		const attemptId = crypto.randomUUID();
		let previousWaitId: string | undefined;
		for (;;) {
			this.#assertLive(record, config);
			const projection = this.#project(this.#now());
			if (!projection) throw refusal("source_inaccessible");
			const { decision, correlationId } = await this.#request(record, config, attemptId, previousWaitId, projection);
			if (decision.kind === "refuse") {
				throw refusal(
					REFUSAL_CODES.has(decision.reason) ? (decision.reason as RoutingRefusalCode) : "host_unavailable",
				);
			}
			if (decision.kind === "wait") {
				this.#assertLive(record, config);
				await this.#pause(record, config, attemptId, correlationId, decision.waitId, decision.reason);
				previousWaitId = decision.waitId;
				continue;
			}
			this.#assertLive(record, config);
			if (this.#grants.has(decision.admissionId)) throw refusal("host_unavailable");
			const grant: ManagedAdmissionGrant = {
				hostEpoch: config.hostEpoch,
				runtimeInstanceId: config.runtimeInstanceId,
				admissionId: decision.admissionId,
				selectionGeneration: decision.selectionGeneration,
				policyRevision: decision.policyRevision,
				accountRef: decision.accountRef,
				operationId: call.operationId,
				attemptId,
				requestGeneration: call.requestGeneration,
				sessionId: call.sessionId,
				modelId: call.modelId,
				purpose: call.purpose,
			};
			const entry: GrantRecord = { grant, call: record, startedAt: null };
			this.#grants.set(grant.admissionId, entry);
			record.grants.set(grant.admissionId, entry);
			record.lastRef = grant.accountRef;
			return grant;
		}
	}

	isConfigured(grant: ManagedAdmissionGrant): boolean {
		const config = this.#config;
		return (
			this.#phase === "configured" &&
			config !== undefined &&
			grant.hostEpoch === config.hostEpoch &&
			grant.runtimeInstanceId === config.runtimeInstanceId
		);
	}

	/** True when this grant re-admits the row the call's previous grant served. */
	refreshesSameRow(call: ManagedCallContext, grant: ManagedAdmissionGrant): boolean {
		return sameRef(this.#records.get(call.operationId)?.previousRef, grant.accountRef);
	}

	// -- ManagedAttemptLifecycle ---------------------------------------------

	started(grant: ManagedAdmissionGrant, startedAt: number): void {
		const entry = this.#grants.get(grant.admissionId);
		if (!entry || entry.startedAt !== null) return;
		entry.startedAt = startedAt;
		this.#emit({
			type: "account.routing.started",
			...this.#identity(grant),
			startedAt,
		});
	}

	outcome(grant: ManagedAdmissionGrant, outcome: ManagedAttemptOutcome): void {
		const entry = this.#grants.get(grant.admissionId);
		if (!entry) return; // exactly once per admission: a late or duplicate settle is dropped
		this.#grants.delete(grant.admissionId);
		entry.call.grants.delete(grant.admissionId);
		for (const block of outcome.quotaBlocks) this.#retainProviderBlock(grant.accountRef, pickBlock(block));
		this.#emit(this.#outcomeFrame(grant, outcome));
		if (outcome.code === "success" || entry.call.call.signal?.aborted) this.#forget(entry.call);
	}

	#identity(grant: ManagedAdmissionGrant): Omit<RpcAccountRoutingStarted, "type" | "startedAt"> {
		return {
			hostEpoch: grant.hostEpoch,
			runtimeInstanceId: grant.runtimeInstanceId,
			admissionId: grant.admissionId,
			operationId: grant.operationId,
			attemptId: grant.attemptId,
			sessionId: grant.sessionId,
			modelId: grant.modelId,
			accountRef: { storeNamespace: grant.accountRef.storeNamespace, nativeRowId: grant.accountRef.nativeRowId },
			selectionGeneration: grant.selectionGeneration,
		};
	}

	#outcomeFrame(grant: ManagedAdmissionGrant, outcome: ManagedAttemptOutcome): RpcAccountRoutingOutcome {
		return {
			type: "account.routing.outcome",
			...this.#identity(grant),
			startedAt: finiteOrNull(outcome.startedAt),
			finishedAt: finiteOrNull(outcome.finishedAt) ?? this.#now(),
			code: outcome.code,
			dispatch: outcome.dispatch,
			replaySafe: outcome.replaySafe === true,
			refusalReason: outcome.refusalReason,
			retryAfterMs: finiteOrNull(outcome.retryAfterMs),
			quotaBlocks: outcome.quotaBlocks.map(pickBlock),
			windows: outcome.windows.map(pickWindow),
		};
	}

	// -- release --------------------------------------------------------------

	/**
	 * Settle every unsettled grant of one logical call, exactly once. The agent loop seeds its first
	 * grant before the stream exists; if the call is cancelled before the stream starts, nothing
	 * else would ever report that grant.
	 */
	releaseOperation(operationId: string): void {
		const record = this.#records.get(operationId);
		if (record) this.#abandon(record, "cancelled", true);
	}

	/** Release everything a session still holds (archive, dispose, session replacement, killed subagent). */
	releaseSession(sessionId: string): void {
		for (const record of this.#records.values()) {
			if (record.call.sessionId === sessionId) this.#abandon(record, "cancelled", true);
		}
	}

	/** Cancel pending work of one call and settle its grants. `includeStarted` also settles dispatched ones. */
	#abandon(record: CallRecord, code: RoutingRefusalCode, includeStarted: boolean): void {
		record.rejectPending?.(refusal(code));
		for (const entry of record.grants.values()) {
			if (entry.startedAt !== null && !includeStarted) continue;
			this.#settleReleased(entry);
		}
		if (includeStarted || record.grants.size === 0) this.#forget(record);
	}

	#settleReleased(entry: GrantRecord): void {
		const finishedAt = this.#now();
		const outcome: ManagedAttemptOutcome =
			entry.startedAt === null
				? undispatchedOutcome("cancelled", finishedAt, "cancelled")
				: {
						startedAt: entry.startedAt,
						finishedAt,
						code: "cancelled",
						dispatch: "dispatched",
						replaySafe: false,
						refusalReason: null,
						retryAfterMs: null,
						quotaBlocks: [],
						windows: [],
					};
		this.outcome(entry.grant, outcome);
	}

	#forget(record: CallRecord): void {
		record.detach?.();
		record.detach = undefined;
		if (record.grants.size === 0) this.#records.delete(record.call.operationId);
	}

	/** Cancel the host connection: pending waits and continuations fail closed, grants settle. Idempotent. */
	dispose(): void {
		if (this.#phase === "disposed") return;
		this.#phase = "disposed";
		this.#lifetime.abort();
		this.#configured.reject(refusal("host_unavailable"));
		for (const record of this.#records.values()) this.#abandon(record, "host_unavailable", true);
		this.#records.clear();
	}

	// -- request / wait -------------------------------------------------------

	#activeConfig(): ActiveConfig {
		const config = this.#config;
		if (this.#phase !== "configured" || !config) throw refusal("host_unavailable");
		return config;
	}

	#assertLive(record: CallRecord, config: ActiveConfig): void {
		if (this.#phase !== "configured" || this.#config !== config) throw refusal("host_unavailable");
		if (record.call.signal?.aborted) throw refusal("cancelled");
	}

	async #untilConfigured(record: CallRecord): Promise<void> {
		if (this.#phase === "configured") return;
		if (this.#phase === "disposed") throw refusal("host_unavailable");
		// Pending-configure: the call is held (no frame leaves) until the host configures, aborts or disconnects.
		const aborted = Promise.withResolvers<never>();
		record.rejectPending = error => aborted.reject(error);
		try {
			await Promise.race([this.#configured.promise, aborted.promise]);
		} finally {
			record.rejectPending = undefined;
		}
		if (record.call.signal?.aborted) throw refusal("cancelled");
	}

	#request(
		record: CallRecord,
		config: ActiveConfig,
		attemptId: string,
		previousWaitId: string | undefined,
		projection: Projection,
	): Promise<{ decision: RpcAccountRoutingDecision; correlationId: string }> {
		const { call } = record;
		const correlationId = `ar-${config.runtimeInstanceId}-${++this.#correlation}`;
		const { promise, resolve, reject } = Promise.withResolvers<{
			decision: RpcAccountRoutingDecision;
			correlationId: string;
		}>();
		const pending: PendingRequest = {
			kind: "request",
			correlationId,
			attemptId,
			settle: decision => resolve({ decision, correlationId }),
		};
		record.pending = pending;
		this.#requests.set(correlationId, { record, pending });
		record.rejectPending = error => {
			if (this.#requests.delete(correlationId)) {
				this.#emit(this.#cancelFrame(record, config, correlationId, attemptId));
			}
			reject(error);
		};
		const settled = (): void => {
			this.#requests.delete(correlationId);
			if (record.pending === pending) record.pending = undefined;
			record.rejectPending = undefined;
		};
		this.#emit({
			type: "account.routing.admit.request",
			id: correlationId,
			hostEpoch: config.hostEpoch,
			runtimeInstanceId: config.runtimeInstanceId,
			operationId: call.operationId,
			attemptId,
			sessionId: call.sessionId,
			purpose: call.purpose as RpcRoutingPurpose,
			provider: "anthropic",
			modelId: call.modelId,
			requestGeneration: call.requestGeneration,
			...(previousWaitId ? { previousWaitId } : {}),
			catalog: this.#catalog(projection, call.modelId, this.#now()),
		} satisfies RpcAccountRoutingAdmitRequest);
		return promise.finally(settled);
	}

	async #pause(
		record: CallRecord,
		config: ActiveConfig,
		attemptId: string,
		correlationId: string,
		waitId: string,
		reason: string,
	): Promise<void> {
		const { call } = record;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const pending: PendingWait = { kind: "wait", correlationId, attemptId, waitId, settle: resolve };
		record.pending = pending;
		this.#waits.set(waitId, { record, pending });
		record.rejectPending = error => {
			if (this.#waits.delete(waitId)) {
				this.#emit({ ...this.#cancelFrame(record, config, correlationId, attemptId), waitId });
			}
			reject(error);
		};
		this.#emit({
			type: "account.routing.paused",
			hostEpoch: config.hostEpoch,
			runtimeInstanceId: config.runtimeInstanceId,
			waitId,
			operationId: call.operationId,
			attemptId,
			sessionId: call.sessionId,
			modelId: call.modelId,
			reason,
		});
		try {
			await promise;
		} finally {
			this.#waits.delete(waitId);
			if (record.pending === pending) record.pending = undefined;
			record.rejectPending = undefined;
		}
	}

	#cancelFrame(record: CallRecord, config: ActiveConfig, id: string, attemptId: string): RpcAccountRoutingCancel {
		return {
			type: "account.routing.cancel",
			id,
			hostEpoch: config.hostEpoch,
			runtimeInstanceId: config.runtimeInstanceId,
			operationId: record.call.operationId,
			attemptId,
			sessionId: record.call.sessionId,
		};
	}

	// -- inbound control frames ----------------------------------------------

	/**
	 * Handle `account.routing.admit.response` and `account.routing.resume` on the control path.
	 * Duplicate, late, wrong-epoch and wrong-instance frames are ignored.
	 */
	handleControlFrame(frame: { type: string; [key: string]: unknown }): boolean {
		if (frame.type === "account.routing.admit.response") {
			this.#onAdmitResponse(frame);
			return true;
		}
		if (frame.type === "account.routing.resume") {
			this.#onResume(frame);
			return true;
		}
		return false;
	}

	#matchesConfig(frame: Record<string, unknown>, required: boolean): boolean {
		const config = this.#config;
		if (this.#phase !== "configured" || !config) return false;
		const { hostEpoch, runtimeInstanceId } = frame;
		if (hostEpoch === undefined && runtimeInstanceId === undefined && !required) return true;
		return hostEpoch === config.hostEpoch && runtimeInstanceId === config.runtimeInstanceId;
	}

	#onAdmitResponse(frame: Record<string, unknown>): void {
		if (!isNonEmptyString(frame.id) || !this.#matchesConfig(frame, true)) return;
		const entry = this.#requests.get(frame.id);
		if (!entry) return;
		const decision = parseDecision(frame.decision);
		this.#requests.delete(frame.id);
		entry.pending.settle(decision ?? { kind: "refuse", reason: "host_unavailable" });
	}

	#onResume(frame: Record<string, unknown>): void {
		if (!isNonEmptyString(frame.waitId) || !this.#matchesConfig(frame, false)) return;
		const entry = this.#waits.get(frame.waitId);
		const config = this.#config;
		if (!entry || !config) return;
		this.#waits.delete(frame.waitId);
		const { call } = entry.record;
		this.#emit({
			type: "account.routing.resumed",
			hostEpoch: config.hostEpoch,
			runtimeInstanceId: config.runtimeInstanceId,
			waitId: frame.waitId,
			operationId: call.operationId,
			requestGeneration: call.requestGeneration,
			sessionId: call.sessionId,
			modelId: call.modelId,
		});
		entry.pending.settle();
	}

	// -- commands -------------------------------------------------------------

	/** `account.routing.configure`. Idempotent for an identical repeat; a new epoch cancels pending admissions. */
	configure(command: RpcAccountRoutingCommand): RpcAccountRoutingConfigureData {
		if (command.type !== "account.routing.configure") throw new AccountRoutingCommandError("invalid_request");
		if (
			command.version !== 1 ||
			!isNonEmptyString(command.hostEpoch) ||
			!isNonEmptyString(command.runtimeInstanceId) ||
			command.scope !== "host-owned" ||
			command.provider !== "anthropic" ||
			command.includedOnly !== true
		) {
			throw new AccountRoutingCommandError("invalid_request");
		}
		if (this.#phase === "disposed") throw new AccountRoutingCommandError("host_unavailable");
		const metadata = this.launch === "metadata";
		// Production never reports complete native coverage until the final caller cutover lands.
		if (!metadata && !this.#completeCoverage) throw new AccountRoutingCommandError("unsupported_runtime");
		const current = this.#config;
		if (current) {
			if (current.hostEpoch === command.hostEpoch) {
				if (current.runtimeInstanceId !== command.runtimeInstanceId) {
					throw new AccountRoutingCommandError("unsupported_runtime");
				}
			} else {
				// New epoch: waits and admissions of the old one end; dispatched requests finish on their old grants.
				for (const record of this.#records.values()) record.rejectPending?.(refusal("host_unavailable"));
			}
		}
		if (!current || current.hostEpoch !== command.hostEpoch) {
			this.#config = { hostEpoch: command.hostEpoch, runtimeInstanceId: command.runtimeInstanceId };
		}
		if (this.#phase === "pending") {
			this.#phase = "configured";
			this.#configured.resolve();
		}
		const projection = this.#project(this.#now());
		return {
			version: 1,
			configured: true,
			completeCoverage: metadata ? false : this.#completeCoverage,
			modelDispatch: metadata ? "forbidden" : "allowed",
			purposes: metadata ? [] : [...ROUTING_PURPOSES],
			accessibleNamespaces: projection ? [projection.namespace] : [],
			catalogs: projection ? [this.#catalog(projection, null, this.#now())] : [],
		};
	}

	/** `account.routing.refresh`: one exact row's billing and window evidence; metadata only. */
	async refresh(command: RpcAccountRoutingCommand): Promise<{ catalog: RpcRoutingCatalog }> {
		if (command.type !== "account.routing.refresh") throw new AccountRoutingCommandError("invalid_request");
		this.#requireLive(command);
		const ref = parseAccountRef(command.accountRef);
		if (!ref || !isNonEmptyString(command.modelId)) throw new AccountRoutingCommandError("invalid_request");
		const authStorage = this.#authStorage;
		if (!authStorage) throw new AccountRoutingCommandError("unsupported_runtime");
		const result = await authStorage.routing.refreshMetadata({
			accountRef: ref,
			modelId: command.modelId,
			baseUrl: DEFAULT_CLAUDE_API_BASE_URL,
			signal: this.#lifetime.signal,
			nowMs: this.#now(),
		});
		if ("refusal" in result) throw new AccountRoutingCommandError(result.code);
		if (result.kind === "unknown") throw new AccountRoutingCommandError(unknownRefreshCode(result.code));
		this.#refreshed.set(refKey(ref), result.observation);
		const nowMs = this.#now();
		const projection = this.#project(nowMs);
		if (!projection) throw new AccountRoutingCommandError("source_inaccessible");
		return { catalog: this.#catalog(projection, command.modelId, nowMs) };
	}

	/** `account.routing.rank`: pure, cache-only ranking of the host's eligible subset. No I/O, refresh or dispatch. */
	rank(command: RpcAccountRoutingCommand): RpcAccountRoutingRankData {
		if (command.type !== "account.routing.rank") throw new AccountRoutingCommandError("invalid_request");
		this.#requireLive(command);
		if (
			!isNonEmptyString(command.modelId) ||
			!Number.isSafeInteger(command.catalogRevision) ||
			command.catalogRevision < 0 ||
			typeof command.nowMs !== "number" ||
			!Number.isFinite(command.nowMs) ||
			!Array.isArray(command.candidateRefs) ||
			command.candidateRefs.length === 0
		) {
			throw new AccountRoutingCommandError("invalid_request");
		}
		const candidateRefs: AccountRef[] = [];
		for (const raw of command.candidateRefs) {
			const ref = parseAccountRef(raw);
			if (!ref) throw new AccountRoutingCommandError("invalid_request");
			candidateRefs.push(ref);
		}
		const projection = this.#project(command.nowMs);
		if (!projection) throw new AccountRoutingCommandError("source_inaccessible");
		// A catalog the host ranked from is stale once the revision moved or the evidence changed.
		if (command.catalogRevision !== this.#catalogRevision || this.#signatureOf(projection) !== this.#signature) {
			throw new AccountRoutingCommandError("metadata_pending");
		}
		const result = rankRoutingCandidates({
			accounts: this.#rankInputs(projection, command.modelId, command.nowMs),
			candidateRefs,
			modelId: command.modelId,
			nowMs: command.nowMs,
		});
		if ("refusal" in result) throw new AccountRoutingCommandError(result.code);
		return {
			method: result.method,
			version: 1,
			catalogRevision: result.catalogRevision,
			anchorRef: result.anchorRef ? { ...result.anchorRef } : null,
			bestCloseRefs: result.bestCloseRefs.map(ref => ({ ...ref })),
		};
	}

	#requireLive(command: { hostEpoch: string; runtimeInstanceId: string }): void {
		const config = this.#config;
		if (this.#phase !== "configured" || !config) throw new AccountRoutingCommandError("host_unavailable");
		if (command.hostEpoch !== config.hostEpoch || command.runtimeInstanceId !== config.runtimeInstanceId) {
			throw new AccountRoutingCommandError("host_unavailable");
		}
	}

	// -- catalog --------------------------------------------------------------

	#retainProviderBlock(ref: AccountRef, block: RoutingQuotaBlock): void {
		let blocks = this.#providerBlocks.get(refKey(ref));
		if (!blocks) {
			blocks = new Map();
			this.#providerBlocks.set(refKey(ref), blocks);
		}
		mergeBlock(blocks, block);
	}

	/** A retained block ends only on a fresh, matching, post-reset observation below full use. */
	#liveProviderBlocks(ref: AccountRef, windows: readonly RoutingWindow[], nowMs: number): RoutingQuotaBlock[] {
		const blocks = this.#providerBlocks.get(refKey(ref));
		if (!blocks) return [];
		const live: RoutingQuotaBlock[] = [];
		for (const [key, block] of blocks) {
			const retired =
				(block.resetAt === null || nowMs >= block.resetAt) &&
				windows.some(
					window =>
						window.id === block.limitId &&
						blockKey({ ...block, scope: window.scope }) === key &&
						window.observedAt !== null &&
						window.observedAt > block.observedAt &&
						(block.resetAt === null || window.observedAt >= block.resetAt) &&
						window.usedFraction !== null &&
						window.usedFraction < 1,
				);
			if (retired) blocks.delete(key);
			else live.push(block);
		}
		return live;
	}

	#project(nowMs: number): Projection | undefined {
		const authStorage = this.#authStorage;
		if (!authStorage) return undefined;
		const identity = authStorage.credentials.routingIdentities({ provider: "anthropic" });
		if (identity.source.status !== "supported") return undefined;
		const namespace = identity.source.storeNamespace;
		const accounts: ProjectedAccount[] = [];
		for (const account of [...identity.accounts].sort((a, b) => a.ref.nativeRowId - b.ref.nativeRowId)) {
			const report = authStorage.usage.peekByCredentialId({
				provider: "anthropic",
				credentialId: account.ref.nativeRowId,
				baseUrl: DEFAULT_CLAUDE_API_BASE_URL,
			});
			const observation = this.#newestObservation(readRoutingObservation(report), account);
			const billing = observation
				? currentIncludedBilling(observation.billing, nowMs)
				: unknownBilling("no_evidence");
			const windows = (observation?.windowObservations ?? []).map(pickWindow);
			const blocks = new Map<string, RoutingQuotaBlock>();
			for (const window of windows) {
				if (
					window.usedFraction !== null &&
					window.usedFraction >= 1 &&
					window.resetAt !== null &&
					window.resetAt > nowMs &&
					window.observedAt !== null &&
					window.validUntil !== null &&
					nowMs < window.validUntil
				) {
					mergeBlock(blocks, {
						limitId: window.id,
						scope: window.scope,
						resetAt: window.resetAt,
						observedAt: window.observedAt,
						source: "native-usage",
						confirmed: true,
					});
				}
			}
			for (const block of this.#liveProviderBlocks(account.ref, windows, nowMs)) mergeBlock(blocks, block);
			accounts.push({
				billing,
				windows,
				quotaBlocks: [...blocks.values()],
				account: {
					ref: { storeNamespace: namespace, nativeRowId: account.ref.nativeRowId },
					display: {
						email: account.email,
						accountId: account.accountId,
						organizationId: account.organizationId,
						organizationName: account.organizationName,
					},
					credentialAvailable: account.credentialAvailable,
					quotaIdentity:
						account.accountId && account.organizationId
							? { accountUuid: account.accountId, organizationUuid: account.organizationId }
							: null,
					billing: pickBilling(billing),
					// ponytail: no verified subscription-tier source exists; stays unknown, never inferred from a label.
					subscriptionTier: { kind: "unknown", observedAt: null, source: null },
					windows,
					quotaBlocks: [...blocks.values()],
				},
			});
		}
		return { identity, namespace, accounts };
	}

	/** The newer of the cached and the refreshed observation, still bound to this row's current identity. */
	#newestObservation(
		cached: RoutingObservation | null,
		account: { ref: AccountRef; accountId: string | null; organizationId: string | null },
	): RoutingObservation | null {
		const held = this.#refreshed.get(refKey(account.ref));
		const sameIdentity =
			held !== undefined &&
			held.storeNamespace === account.ref.storeNamespace &&
			held.nativeRowId === account.ref.nativeRowId &&
			(held.accountId === null || account.accountId === null || held.accountId === account.accountId) &&
			(held.organizationId === null ||
				account.organizationId === null ||
				held.organizationId === account.organizationId);
		if (!sameIdentity) {
			this.#refreshed.delete(refKey(account.ref));
			return cached;
		}
		const age = (observation: RoutingObservation | null): number => observation?.billing.observedAt ?? -1;
		return age(held) >= age(cached) ? held : cached;
	}

	#signatureOf(projection: Projection): string {
		return JSON.stringify([
			projection.identity.credentialGeneration,
			projection.accounts.map(entry => [
				entry.account.ref.nativeRowId,
				entry.account.credentialAvailable,
				entry.billing.state,
				entry.billing.observedAt,
				entry.billing.reason ?? null,
				entry.windows.map(w => [w.id, w.usedFraction, w.observedAt, w.resetAt, w.validUntil]),
				entry.quotaBlocks.map(b => [b.limitId, b.resetAt, b.observedAt]),
			]),
		]);
	}

	#rankInputs(projection: Projection, modelId: string, _nowMs: number): RoutingAccountRankInput[] {
		return projection.accounts.map(entry => ({
			ref: entry.account.ref,
			provider: "anthropic" as const,
			catalogRevision: this.#catalogRevision,
			modelId,
			billing: entry.billing,
			planGateApplies: false,
			planEligibility: "unknown" as const,
			windows: entry.windows,
			quotaBlocks: entry.quotaBlocks,
		}));
	}

	/** Compose the cache-only catalog. The revision moves only when the underlying evidence moves. */
	#catalog(projection: Projection, modelId: string | null, nowMs: number): RpcRoutingCatalog {
		const signature = this.#signatureOf(projection);
		if (signature !== this.#signature) {
			this.#signature = signature;
			this.#catalogRevision += 1;
		}
		const ranks = new Map<string, RoutingRank>();
		if (modelId !== null && projection.accounts.length > 0) {
			const ranked = rankRoutingCandidates({
				accounts: this.#rankInputs(projection, modelId, nowMs),
				candidateRefs: projection.accounts.map(entry => entry.account.ref),
				modelId,
				nowMs,
			});
			if (!("refusal" in ranked)) {
				for (const entry of ranked.accounts) ranks.set(refKey(entry.ref), entry.rank);
			}
		}
		return {
			provider: "anthropic",
			runtimeInstanceId: this.#config?.runtimeInstanceId ?? "",
			storeNamespace: projection.namespace,
			catalogRevision: this.#catalogRevision,
			nativeCredentialGeneration: projection.identity.credentialGeneration,
			observedAt: nowMs,
			authoritativeObservedAt: projection.identity.authoritativeObservedAt,
			authoritativeComplete: projection.identity.authoritativeComplete,
			accounts: projection.accounts.map(entry => ({
				...entry.account,
				rank: ranks.get(refKey(entry.account.ref)) ?? unknownRank(entry.billing),
			})),
		};
	}
}

function unknownRefreshCode(code: string): RoutingRefusalCode {
	switch (code) {
		case "cancelled":
			return "cancelled";
		case "source_changed":
			return "source_changed";
		case "row_unavailable":
			return "no_account";
		case "untrusted_endpoint":
		case "unsupported":
		case "invalid_request":
			return "unsupported_transport";
		default:
			return "billing_unknown";
	}
}

// ---------------------------------------------------------------------------
// Control-path dispatch
// ---------------------------------------------------------------------------

const ACCOUNT_ROUTING_COMMANDS: ReadonlySet<string> = new Set([
	"account.routing.configure",
	"account.routing.refresh",
	"account.routing.rank",
]);

function failure(id: string | undefined, command: string, code: string): RpcAccountRoutingResponse {
	return { id, type: "response", command, success: false, error: code, code };
}

/** Run one `account.routing.*` command and shape its correlated response. Never leaks exception text. */
export async function handleAccountRoutingCommand(
	adapter: ManagedAccountRoutingAdapter | undefined,
	command: RpcAccountRoutingCommand,
): Promise<RpcAccountRoutingResponse> {
	const { id, type } = command;
	// An unmarked independent launch has no adapter and refuses every routing command.
	if (!adapter) return failure(id, type, "unsupported_runtime");
	try {
		const data =
			type === "account.routing.configure"
				? adapter.configure(command)
				: type === "account.routing.refresh"
					? await adapter.refresh(command)
					: adapter.rank(command);
		return { id, type: "response", command: type, success: true, data };
	} catch (error) {
		if (error instanceof AccountRoutingCommandError) return failure(id, type, error.code);
		return failure(id, type, "provider_failed");
	}
}

/**
 * Route an `account.routing.*` stdin frame. Admit responses and resume frames resolve a retained
 * continuation; commands answer on their own correlated response. All of it runs ahead of the serial
 * command queue, so a quota-paused prompt or compaction cannot deadlock its own wake-up.
 *
 * @returns true when the frame belonged to this family (handled or deliberately ignored).
 */
export function dispatchAccountRoutingFrame(
	parsed: unknown,
	adapter: ManagedAccountRoutingAdapter | undefined,
	output: (frame: object) => void,
	track?: (task: Promise<void>) => void,
): boolean {
	if (!isAccountRoutingFrame(parsed)) return false;
	if (ACCOUNT_ROUTING_COMMANDS.has(parsed.type)) {
		const command = parsed as RpcAccountRoutingCommand;
		const task = handleAccountRoutingCommand(adapter, command)
			.then(response => output(response))
			.catch(() => {});
		track?.(task);
		return true;
	}
	adapter?.handleControlFrame(parsed as { type: string; [key: string]: unknown });
	return true;
}

export type { RpcAccountRef };
