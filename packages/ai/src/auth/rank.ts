import {
	currentIncludedBilling,
	type IncludedBillingState,
	type PlanGate,
	ROUTING_BILLING_MAX_AGE_MS,
	type RoutingWindow,
	type UsageLimit,
	type UsageReport,
} from "../usage";
import { claudeRoutingModelFamily, claudeRankingStrategy, selectClaudeSecondaryLimit } from "../usage/claude";
import type { AccountRef, AuthCredential, ApiKeyCredential, OAuthCredential } from "./types";
import { windowRequiredDrain } from "./usage-report";

/** Selected stored credential and its pool index. */
export type CredentialSelection<T extends AuthCredential> = {
	credential: T;
	index: number;
};
/** Selected OAuth credential for routing. */
export type OAuthSelection = CredentialSelection<OAuthCredential>;
/** Selected API-key credential for routing. */
export type ApiKeySelection = CredentialSelection<ApiKeyCredential>;

/** Selected credential with its observed usage. */
export type UsageCandidate<T extends AuthCredential> = {
	selection: CredentialSelection<T>;
	usage: UsageReport | null;
	usageChecked: boolean;
	/** Present after policy-aware ranking; used to decide whether a warm automatic pin may be evicted. */
	inReserve?: boolean;
	/** True only when reserve ranking had a usable remaining-fraction measurement. */
	reserveMeasured?: boolean;
	/**
	 * Present after ranking: the account's renewable allowance for this request is
	 * spent, so if it still serves it draws on paid overage such as Codex credits.
	 */
	allowanceSpent?: boolean;
};

/** OAuth credential eligible for usage ranking. */
export type OAuthCandidate = UsageCandidate<OAuthCredential>;
/** API-key credential eligible for usage ranking. */
export type ApiKeyCandidate = UsageCandidate<ApiKeyCredential>;
/** Ranked candidate with a possible block deadline. */
export type UsageRankingResult<T extends AuthCredential> = UsageCandidate<T> & {
	blockedUntil: number | undefined;
};

/** Candidate with all account-policy and usage ranking metrics. */
export type UsageRankedCandidate<T extends AuthCredential> = UsageCandidate<T> & {
	blocked: boolean;
	blockedUntil?: number;
	inReserve: boolean;
	reserveMeasured?: boolean;
	accountPriority: number;
	hasPriorityBoost: boolean;
	allowanceSpent: boolean;
	usageMeasured: boolean;
	planPriority: number;
	secondaryUsed: number;
	secondaryRequiredDrain: number;
	primaryUsed: number;
	primaryRequiredDrain: number;
	orderPos: number;
};
/** OAuth candidate with complete ranking metrics. */
export type RankedOAuthCandidate = UsageRankedCandidate<OAuthCredential>;
/** API-key candidate with complete ranking metrics. */
export type RankedApiKeyCandidate = UsageRankedCandidate<ApiKeyCredential>;

const USAGE_RANKING_METRIC_EPSILON = 1e-9;
/**
 * Primary (short, e.g. 5h) window used-fraction at or above which a candidate
 * is demoted behind cooler siblings during ranking: a nearly exhausted short
 * window means an imminent mid-session block, so drain urgency defers to it.
 */
const PRIMARY_WINDOW_HOT_FRACTION = 0.85;

/** Rank accounts by model-plan eligibility when a plan gate applies. */
export function planPriority(gate: PlanGate | undefined, report: UsageReport | null): number {
	if (!gate) return 0;
	const eligibility = gate(report);
	return eligibility === true ? 0 : eligibility === undefined ? 1 : 2;
}

function compareUsageRankingMetric(left: number, right: number): number {
	if (left === right) return 0;
	if (!Number.isFinite(left) || !Number.isFinite(right)) return left < right ? -1 : 1;
	const delta = left - right;
	const tolerance = Math.max(USAGE_RANKING_METRIC_EPSILON, Math.max(Math.abs(left), Math.abs(right)) * 0.000001);
	return Math.abs(delta) <= tolerance ? 0 : delta;
}

function compareUsageRankedCandidatePriority(
	left: UsageRankedCandidate<AuthCredential>,
	right: UsageRankedCandidate<AuthCredential>,
	planGated: boolean,
): number {
	if (left.blocked !== right.blocked) return left.blocked ? 1 : -1;
	if (left.blocked && right.blocked) {
		const leftBlockedUntil = left.blockedUntil ?? Number.POSITIVE_INFINITY;
		const rightBlockedUntil = right.blockedUntil ?? Number.POSITIVE_INFINITY;
		if (leftBlockedUntil !== rightBlockedUntil) return leftBlockedUntil - rightBlockedUntil;
		return 0;
	}
	if (planGated && left.planPriority !== right.planPriority) {
		return left.planPriority - right.planPriority;
	}
	// Paid overage (Codex credits) never renews, so an account serving past its
	// allowance yields to any sibling whose renewable allowance is left (#13889).
	if (left.allowanceSpent !== right.allowanceSpent) return left.allowanceSpent ? 1 : -1;
	if (left.inReserve !== right.inReserve) return left.inReserve ? 1 : -1;
	if (left.hasPriorityBoost !== right.hasPriorityBoost) return left.hasPriorityBoost ? -1 : 1;
	// Short-window guard: candidates whose primary (e.g. 5h) window is
	// nearly exhausted rank behind cool ones regardless of drain urgency —
	// overflow lands on the next-most-urgent cool account instead.
	const leftHot = left.primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION;
	const rightHot = right.primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION;
	if (leftHot !== rightHot) return leftHot ? 1 : -1;
	// Usage-backed candidates outrank unmeasured ones: required-drain
	// scores are only comparable between measured windows, and the
	// clockless headroom fallback (0..1) must not let an account whose
	// usage fetch failed shadow a measured sibling.
	const leftMeasured = left.usageMeasured;
	const rightMeasured = right.usageMeasured;
	if (leftMeasured !== rightMeasured) return leftMeasured ? -1 : 1;
	if (left.accountPriority !== right.accountPriority) return right.accountPriority - left.accountPriority;
	// Required drain, descending: the account whose remaining quota must
	// burn fastest to avoid expiring unused at its reset comes first, so
	// staggered resets land at ~100% utilization instead of stranding
	// headroom that a cooler sibling could have absorbed.
	let metric = compareUsageRankingMetric(right.secondaryRequiredDrain, left.secondaryRequiredDrain);
	if (metric !== 0) return metric;
	metric = compareUsageRankingMetric(left.secondaryUsed, right.secondaryUsed);
	if (metric !== 0) return metric;
	metric = compareUsageRankingMetric(right.primaryRequiredDrain, left.primaryRequiredDrain);
	if (metric !== 0) return metric;
	metric = compareUsageRankingMetric(left.primaryUsed, right.primaryUsed);
	if (metric !== 0) return metric;
	return 0;
}

function compareUsageRankedCandidates(
	left: UsageRankedCandidate<AuthCredential>,
	right: UsageRankedCandidate<AuthCredential>,
	planGated: boolean,
): number {
	const priority = compareUsageRankedCandidatePriority(left, right, planGated);
	return priority !== 0 ? priority : left.orderPos - right.orderPos;
}

/** Sort ranked candidates by blocks, plan, spent allowance, reserve, boost, hot window, usage and drain. */
export function orderUsageRankedCandidates<T extends AuthCredential>(
	candidates: UsageRankedCandidate<T>[],
	planGated: boolean,
): UsageCandidate<T>[] {
	candidates.sort((left, right) => compareUsageRankedCandidates(left, right, planGated));
	return candidates.map(candidate => ({
		selection: candidate.selection,
		usage: candidate.usage,
		usageChecked: candidate.usageChecked,
		inReserve: candidate.inReserve,
		reserveMeasured: candidate.reserveMeasured,
		allowanceSpent: candidate.allowanceSpent,
	}));
}

/** Close-choice tolerance for one metric: the same native numeric epsilon the ordinary comparator uses. */
function usageRankingMetricsClose(left: number, right: number): boolean {
	if (left === right) return true;
	if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
	return (
		Math.abs(left - right) <=
		Math.max(USAGE_RANKING_METRIC_EPSILON, Math.max(Math.abs(left), Math.abs(right)) * 0.000001)
	);
}

// ---------------------------------------------------------------------------
// Managed routing rank: pure, cache-only, injected clock. Never fetches or refreshes.
// ---------------------------------------------------------------------------

/** Refusal codes a pool rank can return; they mirror the managed-routing wait/refusal vocabulary. */
export type RoutingRankRefusalCode = "metadata_pending" | "source_changed" | "no_account" | "unsupported_runtime";

/** Typed refusal returned instead of a rank. */
export interface TypedRoutingRankRefusal {
	refusal: true;
	code: RoutingRankRefusalCode;
}

/** A confirmed hard block retained until a fresh matching post-reset observation retires it. */
export interface RoutingQuotaBlock {
	limitId: string;
	scope: RoutingWindow["scope"];
	resetAt: number | null;
	observedAt: number;
	source: "provider-rejection" | "native-usage";
	confirmed: true;
}

/** Cached, identity-bound inputs for one account, all projected for one catalog revision and model. */
export interface RoutingAccountRankInput {
	ref: AccountRef;
	provider: "anthropic";
	catalogRevision: number;
	modelId: string;
	billing: IncludedBillingState;
	/** True when the requested model has a verified plan gate. */
	planGateApplies: boolean;
	planEligibility: true | false | "unknown";
	windows: readonly RoutingWindow[];
	quotaBlocks: readonly RoutingQuotaBlock[];
}

/** Per-account capacity projection. Pool-level anchor and close set live on {@link RoutingPoolRank}. */
export interface RoutingRank {
	method: "claude-native-window-pressure-v1";
	version: 1;
	modelId: string | null;
	modelFamily: string | null;
	planGateApplies: boolean;
	planEligibility: true | false | "unknown";
	billingEligibility: "eligible" | "enabled" | "unknown";
	applicableLimitIds: string[];
	coverage: "complete" | "partial" | "unknown";
	unknownReasons: RoutingRankRefusalCode[];
	usageMeasured: boolean;
	primaryHot: boolean | null;
	primaryUsed: number | null;
	secondaryUsed: number | null;
	primaryRequiredDrain: number | null;
	secondaryRequiredDrain: number | null;
}

/** One candidate's rank, listed best first; ineligible candidates follow eligible ones. */
export interface RoutingAccountRank {
	ref: AccountRef;
	rank: RoutingRank;
	/** True when billing, plan, blocks and coverage all admit this account to the anchor/close set. */
	eligible: boolean;
}

/** Ranked subset. `anchorRef` and `bestCloseRefs` are empty when no candidate is eligible. */
export interface RoutingPoolRank {
	method: "claude-native-window-pressure-v1";
	version: 1;
	catalogRevision: number;
	modelId: string;
	anchorRef: AccountRef | null;
	bestCloseRefs: AccountRef[];
	accounts: readonly RoutingAccountRank[];
}

const SHARED_5H = "anthropic:5h";
const SHARED_7D = "anthropic:7d";

function isFreshWindow(window: RoutingWindow, nowMs: number): boolean {
	const { observedAt, resetAt, validUntil, usedFraction } = window;
	return (
		observedAt !== null &&
		resetAt !== null &&
		validUntil !== null &&
		usedFraction !== null &&
		Number.isFinite(usedFraction) &&
		usedFraction >= 0 &&
		usedFraction <= 1 &&
		observedAt <= nowMs &&
		nowMs < observedAt + ROUTING_BILLING_MAX_AGE_MS &&
		nowMs < validUntil &&
		nowMs < resetAt
	);
}

function scopeApplies(scope: RoutingWindow["scope"], modelId: string, family: string | null): boolean {
	if (scope.kind === "shared") return true;
	return scope.kind === "model" ? scope.modelId === modelId : family !== null && scope.family === family;
}

function sameScope(left: RoutingWindow["scope"], right: RoutingWindow["scope"]): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "model" && right.kind === "model") return left.modelId === right.modelId;
	if (left.kind === "family" && right.kind === "family") return left.family === right.family;
	return true;
}

/** A block is retired only by a fresh, same-limit observation made after its reset and below exhaustion. */
function isBlockRetired(block: RoutingQuotaBlock, windows: readonly RoutingWindow[], nowMs: number): boolean {
	if (block.resetAt === null) return false;
	const resetAt = block.resetAt;
	return windows.some(
		window =>
			window.id === block.limitId &&
			sameScope(window.scope, block.scope) &&
			window.observedAt !== null &&
			window.observedAt >= resetAt &&
			isFreshWindow(window, nowMs) &&
			(window.usedFraction ?? 1) < 1,
	);
}

function asUsageLimit(window: RoutingWindow, windowId: "5h" | "7d"): UsageLimit {
	return {
		id: window.id,
		label: window.label,
		scope: {
			provider: "anthropic",
			windowId,
			shared: window.scope.kind === "shared",
			tier: window.scope.kind === "family" ? window.scope.family : undefined,
		},
		amount: { unit: "percent", usedFraction: window.usedFraction ?? undefined },
		window: { id: windowId, label: window.label, resetsAt: window.resetAt ?? undefined },
	};
}

function rankAccount(input: RoutingAccountRankInput, modelId: string, nowMs: number) {
	const family = claudeRoutingModelFamily(modelId);
	const billing = currentIncludedBilling(input.billing, nowMs);
	const billingEligibility: RoutingRank["billingEligibility"] =
		billing.state === "disabled" ? "eligible" : billing.state;
	const shared5h = input.windows.find(w => w.id === SHARED_5H && w.scope.kind === "shared");
	const shared7d = input.windows.find(w => w.id === SHARED_7D && w.scope.kind === "shared");
	const familyWindows =
		family === null ? [] : input.windows.filter(w => w.scope.kind === "family" && w.scope.family === family);
	const applicableLimitIds = [SHARED_5H, SHARED_7D, ...familyWindows.map(w => w.id)];
	const fresh5h = shared5h !== undefined && isFreshWindow(shared5h, nowMs);
	const fresh7d = shared7d !== undefined && isFreshWindow(shared7d, nowMs);
	const usageMeasured = fresh5h && fresh7d && familyWindows.every(w => isFreshWindow(w, nowMs));
	const coverage: RoutingRank["coverage"] = usageMeasured ? "complete" : fresh5h || fresh7d ? "partial" : "unknown";

	let metrics = {
		primaryHot: null as boolean | null,
		primaryUsed: null as number | null,
		secondaryUsed: null as number | null,
		primaryRequiredDrain: null as number | null,
		secondaryRequiredDrain: null as number | null,
	};
	if (usageMeasured && shared5h && shared7d) {
		const secondaryCandidates = [asUsageLimit(shared7d, "7d"), ...familyWindows.map(w => asUsageLimit(w, "7d"))];
		const secondary = selectClaudeSecondaryLimit(secondaryCandidates, nowMs);
		const primary = asUsageLimit(shared5h, "5h");
		const { primaryMs, secondaryMs } = claudeRankingStrategy.windowDefaults;
		const primaryUsed = shared5h.usedFraction ?? 0;
		metrics = {
			primaryHot: primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION,
			primaryUsed,
			secondaryUsed: secondary?.amount.usedFraction ?? 0,
			primaryRequiredDrain: windowRequiredDrain(primary, nowMs, primaryMs),
			secondaryRequiredDrain: windowRequiredDrain(secondary, nowMs, secondaryMs),
		};
	}

	const planOk = input.planGateApplies ? input.planEligibility === true : input.planEligibility !== false;
	const blocked = input.quotaBlocks.some(
		block =>
			block.confirmed && scopeApplies(block.scope, modelId, family) && !isBlockRetired(block, input.windows, nowMs),
	);
	const unknownReasons: RoutingRankRefusalCode[] =
		coverage !== "complete" ||
		billingEligibility === "unknown" ||
		(input.planGateApplies && input.planEligibility === "unknown")
			? ["metadata_pending"]
			: [];
	const rank: RoutingRank = {
		method: "claude-native-window-pressure-v1",
		version: 1,
		modelId,
		modelFamily: family,
		planGateApplies: input.planGateApplies,
		planEligibility: input.planEligibility,
		billingEligibility,
		applicableLimitIds,
		coverage,
		unknownReasons,
		usageMeasured,
		...metrics,
	};
	return { ref: input.ref, rank, eligible: billingEligibility === "eligible" && planOk && !blocked && usageMeasured };
}

function compareRefs(left: AccountRef, right: AccountRef): number {
	if (left.storeNamespace !== right.storeNamespace) return left.storeNamespace < right.storeNamespace ? -1 : 1;
	return left.nativeRowId - right.nativeRowId;
}

/** Exact (no epsilon) ordering; nulls sort after numbers in either direction. */
function compareNullable(left: number | null, right: number | null, descending: boolean): number {
	if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
	return descending ? right - left : left - right;
}

function compareHeat(left: boolean | null, right: boolean | null): number {
	const order = (value: boolean | null) => (value === null ? 2 : value ? 1 : 0);
	return order(left) - order(right);
}

function compareAccountRanks(left: RoutingAccountRank, right: RoutingAccountRank): number {
	if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
	const l = left.rank;
	const r = right.rank;
	return (
		compareHeat(l.primaryHot, r.primaryHot) ||
		compareNullable(l.secondaryRequiredDrain, r.secondaryRequiredDrain, true) ||
		compareNullable(l.secondaryUsed, r.secondaryUsed, false) ||
		compareNullable(l.primaryRequiredDrain, r.primaryRequiredDrain, true) ||
		compareNullable(l.primaryUsed, r.primaryUsed, false) ||
		compareRefs(left.ref, right.ref)
	);
}

function closeToAnchor(candidate: RoutingRank, anchor: RoutingRank): boolean {
	return (
		candidate.primaryHot === anchor.primaryHot &&
		usageRankingMetricsClose(
			candidate.secondaryRequiredDrain ?? Number.NaN,
			anchor.secondaryRequiredDrain ?? Number.NaN,
		) &&
		usageRankingMetricsClose(candidate.secondaryUsed ?? Number.NaN, anchor.secondaryUsed ?? Number.NaN) &&
		usageRankingMetricsClose(
			candidate.primaryRequiredDrain ?? Number.NaN,
			anchor.primaryRequiredDrain ?? Number.NaN,
		) &&
		usageRankingMetricsClose(candidate.primaryUsed ?? Number.NaN, anchor.primaryUsed ?? Number.NaN)
	);
}

function refuse(code: RoutingRankRefusalCode): TypedRoutingRankRefusal {
	return { refusal: true, code };
}

/**
 * Rank a host-chosen subset of one source's accounts by native window pressure.
 * Pure and cache-only: callers pass already-observed windows and an injected clock; nothing is fetched
 * or refreshed, and cold or stale accounts are reported unmeasured instead of probed.
 */
export function rankRoutingCandidates(input: {
	accounts: readonly RoutingAccountRankInput[];
	candidateRefs: readonly AccountRef[];
	modelId: string;
	nowMs: number;
}): RoutingPoolRank | TypedRoutingRankRefusal {
	const { accounts, candidateRefs, modelId, nowMs } = input;
	if (accounts.some(account => account.provider !== "anthropic")) return refuse("unsupported_runtime");
	if (candidateRefs.length === 0 || accounts.length === 0) return refuse("no_account");
	const namespaces = new Set(accounts.map(account => account.ref.storeNamespace));
	if (namespaces.size !== 1 || candidateRefs.some(ref => !namespaces.has(ref.storeNamespace))) {
		return refuse("source_changed");
	}
	const byKey = new Map<string, RoutingAccountRankInput>();
	for (const account of accounts) {
		const key = `${account.ref.storeNamespace}:${account.ref.nativeRowId}`;
		if (!byKey.has(key)) byKey.set(key, account);
	}
	const candidates = new Map<string, RoutingAccountRankInput>();
	for (const ref of candidateRefs) {
		const key = `${ref.storeNamespace}:${ref.nativeRowId}`;
		const account = byKey.get(key);
		if (!account) return refuse("no_account");
		candidates.set(key, account);
	}
	const selected = [...candidates.values()];
	const catalogRevision = selected[0]?.catalogRevision ?? 0;
	if (selected.some(account => account.catalogRevision !== catalogRevision || account.modelId !== modelId)) {
		return refuse("metadata_pending");
	}

	const ranked = selected.map(account => rankAccount(account, modelId, nowMs)).sort(compareAccountRanks);
	const anchor = ranked[0]?.eligible ? ranked[0] : null;
	const bestCloseRefs = anchor
		? ranked
				.filter(entry => entry.eligible && closeToAnchor(entry.rank, anchor.rank))
				.map(entry => entry.ref)
				.sort(compareRefs)
		: [];
	return {
		method: "claude-native-window-pressure-v1",
		version: 1,
		catalogRevision,
		modelId,
		anchorRef: anchor?.ref ?? null,
		bestCloseRefs,
		accounts: ranked,
	};
}
