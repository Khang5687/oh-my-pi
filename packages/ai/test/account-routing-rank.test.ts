import { describe, expect, test } from "bun:test";
import type { AccountRef } from "../src/auth/types";
import {
	type RoutingAccountRankInput,
	type RoutingPoolRank,
	type RoutingQuotaBlock,
	rankRoutingCandidates,
	type TypedRoutingRankRefusal,
} from "../src/auth/rank";
import { type IncludedBillingState, ROUTING_BILLING_MAX_AGE_MS, type RoutingWindow } from "../src/usage";

const NS = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000_000;
const H = 3_600_000;
const OPUS = "claude-opus-4-5";

const ref = (row: number, ns = NS): AccountRef => ({ storeNamespace: ns, nativeRowId: row });

function win(
	id: string,
	used: number | null,
	resetIn: number,
	over: Partial<RoutingWindow> = {},
	scope: RoutingWindow["scope"] = { kind: "shared" },
): RoutingWindow {
	const observedAt = NOW - 1_000;
	return {
		id,
		label: id,
		scope,
		usedFraction: used,
		resetAt: NOW + resetIn,
		observedAt,
		validUntil: Math.min(observedAt + ROUTING_BILLING_MAX_AGE_MS, NOW + resetIn),
		source: "usage-full",
		...over,
	};
}

const disabled: IncludedBillingState = {
	state: "disabled",
	observedAt: NOW - 1_000,
	validUntil: NOW - 1_000 + ROUTING_BILLING_MAX_AGE_MS,
	source: "claude-usage-spend",
	sourceRevision: null,
};

function account(
	row: number,
	primaryUsed: number,
	secondaryUsed: number,
	over: Partial<RoutingAccountRankInput> = {},
	resets: { primary?: number; secondary?: number } = {},
): RoutingAccountRankInput {
	return {
		ref: ref(row),
		provider: "anthropic",
		catalogRevision: 7,
		modelId: OPUS,
		billing: disabled,
		planGateApplies: false,
		planEligibility: "unknown",
		windows: [
			win("anthropic:5h", primaryUsed, resets.primary ?? 2 * H),
			win("anthropic:7d", secondaryUsed, resets.secondary ?? 48 * H),
		],
		quotaBlocks: [],
		...over,
	};
}

function rank(accounts: RoutingAccountRankInput[], refs: AccountRef[] = accounts.map(a => a.ref), modelId = OPUS) {
	return rankRoutingCandidates({ accounts, candidateRefs: refs, modelId, nowMs: NOW });
}

function pool(result: RoutingPoolRank | TypedRoutingRankRefusal): RoutingPoolRank {
	if ("refusal" in result) throw new Error(`refused: ${result.code}`);
	return result;
}

const rows = (refs: readonly AccountRef[]) => refs.map(r => r.nativeRowId);

describe("rankRoutingCandidates", () => {
	test("cool measured account outranks a hot one even with more headroom", () => {
		const r = pool(rank([account(1, 0.9, 0.1), account(2, 0.2, 0.6)]));
		expect(r.anchorRef).toEqual(ref(2));
		expect(r.bestCloseRefs).toEqual([ref(2)]);
		expect(r.accounts.map(a => a.ref.nativeRowId)).toEqual([2, 1]);
		expect(r.accounts[1]?.rank.primaryHot).toBe(true);
		expect(r.method).toBe("claude-native-window-pressure-v1");
		expect(r.catalogRevision).toBe(7);
	});

	test("staggered weekly resets: sooner-expiring headroom (higher required drain) leads; reset does not zero it", () => {
		const accounts = [
			account(1, 0.3, 0.5, {}, { secondary: 100 * H }),
			account(2, 0.3, 0.5, {}, { secondary: 10 * H }),
			account(3, 0.3, 0.5, {}, { secondary: 40 * H }),
			account(4, 0.3, 0.5, {}, { secondary: 70 * H }),
			account(5, 0.3, 0.5, {}, { secondary: 160 * H }),
		];
		const r = pool(rank(accounts));
		expect(rows(r.accounts.map(a => a.ref))).toEqual([2, 3, 4, 1, 5]);
		expect(r.anchorRef).toEqual(ref(2));
	});

	test("close set compares everyone to the single anchor, never chains within epsilon", () => {
		const step = 2.5e-7; // each neighbour is within tolerance of the next; 1 and 3 are not
		const accounts = [
			account(1, 0.3, 0.4),
			account(2, 0.3, 0.4 + step),
			account(3, 0.3, 0.4 + 2 * step),
			account(4, 0.3, 0.4 + 3 * step),
		];
		const r = pool(rank(accounts));
		expect(r.anchorRef).toEqual(ref(1));
		expect(rows(r.bestCloseRefs)).toEqual([1, 2]);
	});

	test("close set is stable namespace-then-row ordered and ties break by it", () => {
		const a = account(9, 0.3, 0.4);
		const b = account(2, 0.3, 0.4);
		const r = pool(rank([a, b]));
		expect(r.anchorRef).toEqual(ref(2));
		expect(rows(r.bestCloseRefs)).toEqual([2, 9]);
	});

	test("subset rerank: excluded high raw anchor is never chosen", () => {
		const accounts = [
			account(1, 0.1, 0.1),
			account(2, 0.3, 0.5),
			account(3, 0.3, 0.5),
			account(4, 0.5, 0.7),
			account(5, 0.6, 0.8),
			account(6, 0.2, 0.9),
		];
		const all = pool(rank(accounts));
		const subset = pool(rank(accounts, [ref(2), ref(3), ref(4)]));
		expect(all.anchorRef).not.toEqual(subset.anchorRef);
		expect(subset.accounts.map(a => a.ref.nativeRowId).sort()).toEqual([2, 3, 4]);
		expect(rows(subset.bestCloseRefs)).toEqual([2, 3]);
	});

	test("duplicate candidate refs deduplicate", () => {
		const a = account(1, 0.2, 0.2);
		const r = pool(rank([a, account(2, 0.4, 0.4)], [a.ref, a.ref, ref(2)]));
		expect(r.accounts).toHaveLength(2);
	});

	test("Fable confirmed exhaustion blocks only a Fable request; a stale-reset block stays until fresh post-reset evidence", () => {
		const block: RoutingQuotaBlock = {
			limitId: "anthropic:7d:fable",
			scope: { kind: "family", family: "fable" },
			resetAt: NOW - 10_000,
			observedAt: NOW - 3 * H,
			source: "native-usage",
			confirmed: true,
		};
		const fableWindow = win("anthropic:7d:fable", 1, 40 * H, {}, { kind: "family", family: "fable" });
		const blocked = account(1, 0.1, 0.1, { quotaBlocks: [block], modelId: "claude-fable-1" });
		blocked.windows = [...blocked.windows, fableWindow];
		const other = account(2, 0.8, 0.8, { modelId: "claude-fable-1" });
		other.windows = [
			...other.windows,
			win("anthropic:7d:fable", 0.2, 40 * H, {}, { kind: "family", family: "fable" }),
		];
		const fable = pool(rank([blocked, other], undefined, "claude-fable-1"));
		expect(fable.anchorRef).toEqual(ref(2)); // reset tick alone does not retire the block

		const unrelated = account(1, 0.1, 0.1, { quotaBlocks: [block] });
		const sonnetLike = pool(rank([unrelated, account(2, 0.8, 0.8)]));
		expect(sonnetLike.anchorRef).toEqual(ref(1)); // Opus request ignores the Fable block

		const retired = account(1, 0.1, 0.1, { quotaBlocks: [block], modelId: "claude-fable-1" });
		retired.windows = [
			...retired.windows,
			win("anthropic:7d:fable", 0.05, 40 * H, {}, { kind: "family", family: "fable" }),
		];
		const after = pool(rank([retired, other], undefined, "claude-fable-1"));
		expect(after.anchorRef).toEqual(ref(1)); // fresh post-reset observation retires it
	});

	test("missing, stale, or malformed required window nulls all metrics and excludes the account", () => {
		const missing = account(1, 0.1, 0.1);
		missing.windows = missing.windows.filter(w => w.id !== "anthropic:7d");
		const stale = account(2, 0.1, 0.1);
		stale.windows = [win("anthropic:5h", 0.1, 2 * H), win("anthropic:7d", 0.1, -1_000)];
		const malformed = account(3, 0.1, 0.1);
		malformed.windows = [win("anthropic:5h", 0.1, 2 * H), win("anthropic:7d", Number.NaN, 48 * H)];
		const old = account(4, 0.1, 0.1);
		old.windows = [
			win("anthropic:5h", 0.1, 2 * H, { observedAt: NOW - 400_000, validUntil: NOW + 1 }),
			win("anthropic:7d", 0.1, 48 * H),
		];
		const good = account(5, 0.7, 0.7);
		const r = pool(rank([missing, stale, malformed, old, good]));
		expect(r.anchorRef).toEqual(ref(5));
		expect(r.bestCloseRefs).toEqual([ref(5)]);
		expect(r.accounts[0]?.ref).toEqual(ref(5)); // null metrics sort after finite ones
		for (const entry of r.accounts.slice(1)) {
			expect(entry.rank).toMatchObject({
				usageMeasured: false,
				primaryHot: null,
				primaryUsed: null,
				secondaryUsed: null,
				primaryRequiredDrain: null,
				secondaryRequiredDrain: null,
			});
			expect(entry.rank.coverage).not.toBe("complete");
		}
		expect(r.accounts.find(a => a.ref.nativeRowId === 1)?.rank.coverage).toBe("partial");
	});

	test("billing: only unexpired explicit disabled is ranked", () => {
		const enabled = account(1, 0.1, 0.1, { billing: { ...disabled, state: "enabled" } });
		const expired = account(2, 0.1, 0.1, {
			billing: { ...disabled, observedAt: NOW - ROUTING_BILLING_MAX_AGE_MS, validUntil: NOW },
		});
		const unknown = account(3, 0.1, 0.1, {
			billing: { state: "unknown", observedAt: null, validUntil: null, source: null, sourceRevision: null },
		});
		const ok = account(4, 0.9, 0.9);
		const r = pool(rank([enabled, expired, unknown, ok]));
		expect(r.anchorRef).toEqual(ref(4));
		const byRow = (n: number) => r.accounts.find(a => a.ref.nativeRowId === n)?.rank.billingEligibility;
		expect([byRow(1), byRow(2), byRow(3), byRow(4)]).toEqual(["enabled", "unknown", "unknown", "eligible"]);
	});

	test("plan gate: unknown eligibility fails only when a gate applies", () => {
		const gatedUnknown = account(1, 0.1, 0.1, { planGateApplies: true, planEligibility: "unknown" });
		const gatedOk = account(2, 0.5, 0.5, { planGateApplies: true, planEligibility: true });
		expect(pool(rank([gatedUnknown, gatedOk])).anchorRef).toEqual(ref(2));
		const open = account(1, 0.1, 0.1, { planGateApplies: false, planEligibility: "unknown" });
		expect(pool(rank([open, account(2, 0.5, 0.5)])).anchorRef).toEqual(ref(1));
	});

	test("applicable family window must be fresh; unrelated family windows are ignored", () => {
		const a = account(1, 0.1, 0.1, { modelId: "claude-fable-1" });
		a.windows = [...a.windows, win("anthropic:7d:fable", null, 40 * H, {}, { kind: "family", family: "fable" })];
		const b = account(2, 0.5, 0.5, { modelId: "claude-fable-1" });
		const c = account(3, 0.6, 0.6, { modelId: "claude-fable-1" });
		c.windows = [...c.windows, win("anthropic:7d:opus", null, 40 * H, {}, { kind: "family", family: "opus" })];
		const r = pool(rank([a, b, c], undefined, "claude-fable-1"));
		expect(rows(r.bestCloseRefs)).toEqual([2]);
		expect(r.accounts.find(x => x.ref.nativeRowId === 1)?.rank.usageMeasured).toBe(false);
		expect(r.accounts.find(x => x.ref.nativeRowId === 3)?.rank.usageMeasured).toBe(true);
	});

	test("weekly model window with higher pressure drives secondary metrics", () => {
		const a = account(1, 0.1, 0.1);
		a.windows = [...a.windows, win("anthropic:7d:opus", 0.8, 48 * H, {}, { kind: "family", family: "opus" })];
		const r = pool(rank([a]));
		expect(r.accounts[0]?.rank.secondaryUsed).toBe(0.8);
		expect(r.accounts[0]?.rank.applicableLimitIds).toEqual(["anthropic:5h", "anthropic:7d", "anthropic:7d:opus"]);
	});

	test("typed refusals", () => {
		const a = account(1, 0.1, 0.1);
		const code = (x: RoutingPoolRank | TypedRoutingRankRefusal) => ("refusal" in x ? x.code : "ok");
		expect(code(rank([a], [ref(99)]))).toBe("no_account");
		expect(code(rank([a], []))).toBe("no_account");
		expect(code(rank([a], [ref(1, "22222222-2222-4222-8222-222222222222")]))).toBe("source_changed");
		expect(code(rank([a], undefined, "claude-sonnet-4-5"))).toBe("metadata_pending");
		expect(code(rank([a, account(2, 0.1, 0.1, { catalogRevision: 6 })]))).toBe("metadata_pending");
		expect(code(rank([{ ...a, provider: "openai" as unknown as "anthropic" }]))).toBe("unsupported_runtime");
	});

	test("performs no I/O", () => {
		const originalFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (() => {
			calls += 1;
			throw new Error("no fetch allowed");
		}) as unknown as typeof fetch;
		try {
			pool(rank([account(1, 0.1, 0.1), account(2, 0.2, 0.2)]));
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(calls).toBe(0);
	});
});
