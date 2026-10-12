/**
 * Strict exact-row resolution for host-managed Claude routing.
 *
 * The host picks one native row; this module turns that choice into a bearer or a typed refusal.
 * It never ranks, rotates, falls back to a sibling, API key or environment credential, or marks a
 * durable native quota block. The row is addressed by `{storeNamespace, nativeRowId}` and re-read
 * by id after every await, so deletion or index compaction cannot retarget a sibling.
 */
import { ManagedDispatchRefusedError, type ManagedResolvedApiKey, undispatchedOutcome } from "../auth-retry";
import { type RoutingExactUsageResult } from "./types";
import { claudeRoutingModelFamily } from "../usage/claude";
import { currentIncludedBilling, readRoutingObservation, type RoutingObservation, type RoutingWindow } from "../usage";
import type { KeyOverrides } from "./cascade";
import type { CredentialPool } from "./pool";
import {
	type RoutingAccountRankInput,
	type RoutingPoolRank,
	rankRoutingCandidates,
	type TypedRoutingRankRefusal,
} from "./rank";
import {
	type AccountRef,
	isStoreNamespace,
	type ManagedAdmissionBinding,
	type ManagedAdmissionGrant,
	type ManagedAttemptOutcome,
	type ManagedCallContext,
	type OAuthAccessResolution,
	type OAuthApi,
	type OAuthCredential,
	type RoutingRefusalCode,
	type UsageApi,
} from "./types";
import { isTrustedClaudeBaseUrl } from "./usage";

/** Host/runtime callbacks the strict resolver reports through. Implemented by the owned-runtime adapter. */
export interface ManagedAttemptLifecycle {
	/** Whether the captured host epoch and runtime configuration still hold for this grant. */
	isConfigured(grant: ManagedAdmissionGrant): boolean;
	started(grant: ManagedAdmissionGrant, startedAt: number): void;
	outcome(grant: ManagedAdmissionGrant, outcome: ManagedAttemptOutcome): void;
}

export interface RoutingResolveExactRequest {
	accountRef: AccountRef;
	modelId: string;
	/** Must be the trusted first-party Anthropic API root. */
	baseUrl: string;
	admission: ManagedAdmissionGrant;
	call: ManagedCallContext;
	lifecycle: ManagedAttemptLifecycle;
	signal?: AbortSignal;
	/** Re-mint this row's access token (provider 401 recovery) before resolving. Billing reuse is unchanged. */
	forceRefresh?: boolean;
}

export interface RoutingRefreshMetadataRequest {
	accountRef: AccountRef;
	modelId: string;
	baseUrl: string;
	signal?: AbortSignal;
	nowMs: number;
}

/** Typed refusal returned instead of a bearer. `retryAfterMs` is null when no schedule is known. */
export interface RoutingRefusal {
	refusal: true;
	code: RoutingRefusalCode;
	retryAfterMs: number | null;
}

export interface RoutingRankInput {
	accounts: readonly RoutingAccountRankInput[];
	candidateRefs: readonly AccountRef[];
	modelId: string;
	nowMs: number;
}

/** Strict managed-routing operations over one authoritative native source. */
export interface RoutingApi {
	/** Resolve exactly `accountRef` for one HTTP attempt, or refuse. */
	resolveExact(request: RoutingResolveExactRequest): Promise<ManagedResolvedApiKey | RoutingRefusal>;
	/** Prepare the exact row and read fresh trusted billing/window evidence; metadata only. */
	refreshMetadata(request: RoutingRefreshMetadataRequest): Promise<RoutingExactUsageResult | RoutingRefusal>;
	/** Pure, cache-only ranking of a host-chosen subset. */
	rankCandidates(input: RoutingRankInput): RoutingPoolRank | TypedRoutingRankRefusal;
}

export interface RoutingResolverDeps {
	pool: CredentialPool;
	overrides: KeyOverrides;
	oauth: Pick<OAuthApi, "accessById">;
	usage: Pick<UsageApi, "refreshRoutingObservation" | "peekByCredentialId">;
	now: () => number;
}

interface RowIdentity {
	accountId: string | null;
	orgId: string | null;
}

type RowRead =
	| { ok: true; credential: OAuthCredential; identity: RowIdentity }
	| { ok: false; code: RoutingRefusalCode };

const refuse = (code: RoutingRefusalCode, retryAfterMs: number | null = null): RoutingRefusal => ({
	refusal: true,
	code,
	retryAfterMs,
});

function scopeApplies(scope: RoutingWindow["scope"], modelId: string, family: string | null): boolean {
	if (scope.kind === "shared") return true;
	return scope.kind === "model" ? scope.modelId === modelId : family !== null && scope.family === family;
}

/** Confirmed-exhausted applicable windows in a fresh observation; returns the latest reset, or null. */
function exhaustedUntil(observation: RoutingObservation, modelId: string, nowMs: number): number | null {
	const family = claudeRoutingModelFamily(modelId);
	let until: number | null = null;
	for (const window of observation.windowObservations) {
		if (!scopeApplies(window.scope, modelId, family)) continue;
		if (window.usedFraction === null || window.usedFraction < 1) continue;
		if (window.observedAt === null || window.observedAt > nowMs) continue;
		if (window.validUntil === null || nowMs >= window.validUntil) continue;
		if (window.resetAt === null || window.resetAt <= nowMs) continue;
		until = until === null ? window.resetAt : Math.max(until, window.resetAt);
	}
	return until;
}

export class RoutingResolver implements RoutingApi {
	readonly #deps: RoutingResolverDeps;

	constructor(deps: RoutingResolverDeps) {
		this.#deps = deps;
	}

	rankCandidates(input: RoutingRankInput): RoutingPoolRank | TypedRoutingRankRefusal {
		return rankRoutingCandidates(input);
	}

	/** Re-read the exact durable row. Never consults list position. */
	#readRow(ref: AccountRef): RowRead {
		if (!isStoreNamespace(ref?.storeNamespace) || !Number.isSafeInteger(ref.nativeRowId) || ref.nativeRowId < 1) {
			return { ok: false, code: "no_account" };
		}
		const source = this.#deps.pool.routingIdentities({ provider: "anthropic" }).source;
		if (source.status !== "supported" || source.storeNamespace !== ref.storeNamespace) {
			return { ok: false, code: "source_changed" };
		}
		const entry = this.#deps.pool.entries("anthropic").find(candidate => candidate.id === ref.nativeRowId);
		if (entry?.credential.type !== "oauth") return { ok: false, code: "no_account" };
		const credential = entry.credential;
		return {
			ok: true,
			credential,
			identity: { accountId: credential.accountId ?? null, orgId: credential.orgId ?? null },
		};
	}

	#validate(request: {
		accountRef: AccountRef;
		modelId: string;
		baseUrl: string;
		signal?: AbortSignal;
	}): RoutingRefusal | null {
		if (request.signal?.aborted) return refuse("cancelled");
		if (typeof request.modelId !== "string" || request.modelId.length === 0) return refuse("unsupported_transport");
		if (typeof request.baseUrl !== "string" || !isTrustedClaudeBaseUrl(request.baseUrl)) {
			return refuse("unsupported_transport");
		}
		// A static key or config override owns the provider: the strict path never enters that cascade.
		if (this.#deps.overrides.has("anthropic")) return refuse("auth_unavailable");
		return null;
	}

	async #prepare(request: {
		accountRef: AccountRef;
		modelId: string;
		baseUrl: string;
		signal?: AbortSignal;
		forceRefresh?: boolean;
	}): Promise<
		{ refusal: RoutingRefusal } | { access: Extract<OAuthAccessResolution, { ok: true }>; identity: RowIdentity }
	> {
		const before = this.#readRow(request.accountRef);
		if (!before.ok) return { refusal: refuse(before.code) };
		if (before.identity.accountId === null && before.identity.orgId === null) {
			// Unknown row binding cannot anchor billing evidence.
			return { refusal: refuse("billing_unknown") };
		}
		const access = await this.#deps.oauth.accessById("anthropic", request.accountRef.nativeRowId, {
			signal: request.signal,
			modelId: request.modelId,
			baseUrl: request.baseUrl,
			forceRefresh: request.forceRefresh,
			recordAffinity: false,
		});
		if (request.signal?.aborted) return { refusal: refuse("cancelled") };
		// Rebind by durable id: the row may have been removed, replaced or re-scoped during the awaits.
		const after = this.#readRow(request.accountRef);
		if (!after.ok) return { refusal: refuse(after.code) };
		if (!access || !access.ok) return { refusal: refuse("auth_unavailable") };
		if (
			after.identity.accountId !== before.identity.accountId ||
			after.identity.orgId !== before.identity.orgId ||
			(access.accountId ?? null) !== after.identity.accountId ||
			(access.orgId ?? null) !== after.identity.orgId
		) {
			return { refusal: refuse("billing_unknown") };
		}
		return { access, identity: after.identity };
	}

	async refreshMetadata(request: RoutingRefreshMetadataRequest): Promise<RoutingExactUsageResult | RoutingRefusal> {
		const invalid = this.#validate(request);
		if (invalid) return invalid;
		const prepared = await this.#prepare(request);
		if ("refusal" in prepared) return prepared.refusal;
		return this.#deps.usage.refreshRoutingObservation({
			accountRef: request.accountRef,
			provider: "anthropic",
			modelId: request.modelId,
			baseUrl: request.baseUrl,
			signal: request.signal,
			nowMs: request.nowMs,
		});
	}

	async resolveExact(request: RoutingResolveExactRequest): Promise<ManagedResolvedApiKey | RoutingRefusal> {
		let result: ManagedResolvedApiKey | RoutingRefusal;
		try {
			result = await this.#resolveExact(request);
		} catch (error) {
			request.lifecycle.outcome(
				request.admission,
				undispatchedOutcome("resolution_refused", this.#deps.now(), "auth_unavailable"),
			);
			throw error;
		}
		// A grant that never yields a bearer still gets exactly one outcome, so the host can release it.
		if ("refusal" in result) {
			const code = result.code === "cancelled" ? "cancelled" : "resolution_refused";
			request.lifecycle.outcome(
				request.admission,
				undispatchedOutcome(code, this.#deps.now(), result.code, result.retryAfterMs),
			);
		}
		return result;
	}

	async #resolveExact(request: RoutingResolveExactRequest): Promise<ManagedResolvedApiKey | RoutingRefusal> {
		const { accountRef, admission, call, lifecycle } = request;
		const invalid = this.#validate(request);
		if (invalid) return invalid;
		const grantRef = admission.accountRef;
		if (grantRef.storeNamespace !== accountRef.storeNamespace || grantRef.nativeRowId !== accountRef.nativeRowId) {
			return refuse("source_changed");
		}
		if (!lifecycle.isConfigured(admission)) return refuse("host_unavailable");

		const prepared = await this.#prepare(request);
		if ("refusal" in prepared) return prepared.refusal;
		const { access, identity } = prepared;

		const refreshed = await this.#deps.usage.refreshRoutingObservation({
			accountRef,
			provider: "anthropic",
			modelId: request.modelId,
			baseUrl: request.baseUrl,
			signal: request.signal,
			nowMs: this.#deps.now(),
		});
		if (request.signal?.aborted) return refuse("cancelled");
		if (refreshed.kind === "unknown") return refuse(this.#unknownCode(refreshed.code));
		const observation = refreshed.observation;

		// Billing and identity are rechecked after every await, and again in beforeDispatch.
		const settled = this.#readRow(accountRef);
		if (!settled.ok) return refuse(settled.code);
		if (settled.identity.accountId !== identity.accountId || settled.identity.orgId !== identity.orgId) {
			return refuse("billing_unknown");
		}
		const nowMs = this.#deps.now();
		const billing = currentIncludedBilling(observation.billing, nowMs);
		if (billing.state === "enabled") return refuse("billing_enabled");
		if (billing.state !== "disabled") return refuse("billing_unknown");
		const blockedUntil = exhaustedUntil(observation, request.modelId, nowMs);
		if (blockedUntil !== null) return refuse("quota_blocked", blockedUntil - nowMs);
		// No verified plan-entitlement source exists yet (subscription tier stays unknown), so no
		// entitlement gate applies; the first verified mapping adds `entitlement_unavailable` here.

		const capturedBilling = billing;
		const binding: ManagedAdmissionBinding = {
			grant: admission,
			call,
			beforeDispatch: async signal => {
				if (signal?.aborted || call.signal?.aborted) throw new ManagedDispatchRefusedError("cancelled");
				if (!lifecycle.isConfigured(admission)) throw new ManagedDispatchRefusedError("host_unavailable");
				const row = this.#readRow(accountRef);
				if (!row.ok) throw new ManagedDispatchRefusedError(row.code);
				if (row.identity.accountId !== identity.accountId || row.identity.orgId !== identity.orgId) {
					throw new ManagedDispatchRefusedError("billing_unknown");
				}
				// A newer no-I/O observation that turned billing on (or conflicting) revokes the grant.
				const peeked = readRoutingObservation(
					this.#deps.usage.peekByCredentialId({
						provider: "anthropic",
						credentialId: accountRef.nativeRowId,
						baseUrl: request.baseUrl,
					}),
				);
				if (peeked && peeked.billing.state === "enabled") throw new ManagedDispatchRefusedError("billing_enabled");
				const current = currentIncludedBilling(capturedBilling, this.#deps.now());
				if (current.state !== "disabled") throw new ManagedDispatchRefusedError("billing_unknown");
			},
			started: startedAt => lifecycle.started(admission, startedAt),
			outcome: outcome => lifecycle.outcome(admission, outcome),
		};
		const credential = settled.credential;
		return {
			apiKey: access.accessToken,
			credentialId: accountRef.nativeRowId,
			oauthIdentity: {
				...(identity.accountId ? { accountId: identity.accountId } : {}),
				...(identity.orgId ? { orgId: identity.orgId } : {}),
				...(credential.region ? { region: credential.region } : {}),
				...(credential.inferenceRegion ? { inferenceRegion: credential.inferenceRegion } : {}),
			},
			managedAdmission: binding,
		};
	}

	#unknownCode(code: Extract<RoutingExactUsageResult, { kind: "unknown" }>["code"]): RoutingRefusalCode {
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
}
