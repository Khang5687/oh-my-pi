import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { RoutingObservation, UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { claudeUsageProvider } from "@oh-my-pi/pi-ai/usage/claude";

const CANONICAL_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const USAGE_PAYLOAD = {
	five_hour: { utilization: 17, resets_at: new Date(Date.now() + 60 * 60_000).toISOString() },
	seven_day: { utilization: 75, resets_at: new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString() },
	limits: [
		{
			kind: "weekly_scoped",
			percent: 100,
			resets_at: new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString(),
			scope: { model: { display_name: "Fable" } },
		},
	],
};

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function recordingFetch(handler: (url: string) => Response): { fetch: FetchImpl; urls: string[] } {
	const urls: string[] = [];
	const fetch = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		urls.push(url);
		return handler(url);
	}) as FetchImpl;
	return { fetch, urls };
}

function plainUsageUrls(urls: readonly string[]): string[] {
	return urls.filter(url => {
		const parsed = new URL(url);
		return parsed.pathname.endsWith("/usage") && parsed.search === "";
	});
}

function params(baseUrl?: string) {
	return {
		provider: "anthropic" as const,
		credential: {
			type: "oauth" as const,
			accessToken: "oat-test",
			accountId: "account_test",
			email: "user@example.com",
			expiresAt: Date.now() + 60_000,
		},
		...(baseUrl === undefined ? {} : { baseUrl }),
	};
}

function context(fetch: FetchImpl): UsageFetchContext {
	return { fetch, retryWait: async () => {} };
}

describe("claudeUsageProvider usage endpoint resolution", () => {
	it("falls back to the canonical endpoint when a custom baseUrl does not serve usage", async () => {
		const { fetch, urls } = recordingFetch(url =>
			url === CANONICAL_USAGE_URL ? jsonResponse(200, USAGE_PAYLOAD) : jsonResponse(404, { error: "not_found" }),
		);

		const report = await claudeUsageProvider.fetchUsage(
			params("https://gateway.example.com/claude/v1"),
			context(fetch),
		);

		expect(plainUsageUrls(urls)).toEqual(["https://gateway.example.com/claude/api/oauth/usage", CANONICAL_USAGE_URL]);
		expect(report?.metadata?.endpoint).toBe(CANONICAL_USAGE_URL);
		// The model-scoped weekly row is what rate-limit headers cannot refresh
		// unless the request itself hit that family — it must survive the fallback.
		expect(report?.limits.find(limit => limit.scope.tier === "fable")?.amount.usedFraction).toBe(1);
		expect(report?.limits.find(limit => limit.id === "anthropic:7d")?.amount.usedFraction).toBe(0.75);
	});

	it("keeps a custom baseUrl that does serve usage and never probes the canonical endpoint", async () => {
		const { fetch, urls } = recordingFetch(() => jsonResponse(200, USAGE_PAYLOAD));

		const report = await claudeUsageProvider.fetchUsage(params("https://mirror.example.com/v1"), context(fetch));

		expect(plainUsageUrls(urls)).toEqual(["https://mirror.example.com/api/oauth/usage"]);
		expect(report?.metadata?.endpoint).toBe("https://mirror.example.com/api/oauth/usage");
	});

	it("does not double-request when the configured baseUrl already resolves to the canonical endpoint", async () => {
		const { fetch, urls } = recordingFetch(() => jsonResponse(404, { error: "not_found" }));

		const report = await claudeUsageProvider.fetchUsage(params("https://api.anthropic.com/v1"), context(fetch));

		expect(report).toBeNull();
		expect(plainUsageUrls(urls)).toEqual([CANONICAL_USAGE_URL]);
	});

	it("keeps the request on a custom baseUrl that refuses the credential", async () => {
		const { fetch, urls } = recordingFetch(() => jsonResponse(401, { error: "unauthorized" }));

		const report = await claudeUsageProvider.fetchUsage(params("https://gateway.example.com/v1"), context(fetch));

		// A 401 is the configured host's answer about this account, not a missing
		// endpoint: moving the token to another destination is not ours to decide.
		expect(report).toBeNull();
		expect(plainUsageUrls(urls)).toEqual(["https://gateway.example.com/api/oauth/usage"]);
	});

	it("keeps the request on a custom baseUrl that fails transiently", async () => {
		const { fetch, urls } = recordingFetch(() => jsonResponse(503, { error: "unavailable" }));

		const report = await claudeUsageProvider.fetchUsage(params("https://gateway.example.com/v1"), context(fetch));

		expect(report).toBeNull();
		// Retried on the configured host only; the next poll tries it again.
		expect(plainUsageUrls(urls)).toEqual(
			Array.from({ length: 3 }, () => "https://gateway.example.com/api/oauth/usage"),
		);
	});

	it("falls back when a custom baseUrl answers 200 with an unrelated body", async () => {
		const { fetch, urls } = recordingFetch(url =>
			url === CANONICAL_USAGE_URL ? jsonResponse(200, USAGE_PAYLOAD) : jsonResponse(200, { hello: "world" }),
		);

		const report = await claudeUsageProvider.fetchUsage(params("https://gateway.example.com/v1"), context(fetch));

		expect(plainUsageUrls(urls)).toEqual([
			...Array.from({ length: 3 }, () => "https://gateway.example.com/api/oauth/usage"),
			CANONICAL_USAGE_URL,
		]);
		expect(report?.metadata?.endpoint).toBe(CANONICAL_USAGE_URL);
	});

	it("falls back when a custom baseUrl answers 200 with an SPA index page", async () => {
		const { fetch, urls } = recordingFetch(url =>
			url === CANONICAL_USAGE_URL
				? jsonResponse(200, USAGE_PAYLOAD)
				: new Response("<!doctype html><title>gateway</title>", {
						status: 200,
						headers: { "Content-Type": "text/html" },
					}),
		);

		const report = await claudeUsageProvider.fetchUsage(params("https://gateway.example.com/v1"), context(fetch));

		// A single probe is enough: an HTML 200 is not a usage endpoint having a
		// bad moment, so retrying it only delays the canonical fallback.
		expect(plainUsageUrls(urls)).toEqual(["https://gateway.example.com/api/oauth/usage", CANONICAL_USAGE_URL]);
		expect(report?.metadata?.endpoint).toBe(CANONICAL_USAGE_URL);
	});

	it("falls back when a custom baseUrl answers 200 with an empty body", async () => {
		const { fetch, urls } = recordingFetch(url =>
			url === CANONICAL_USAGE_URL ? jsonResponse(200, USAGE_PAYLOAD) : new Response("", { status: 200 }),
		);

		const report = await claudeUsageProvider.fetchUsage(params("https://gateway.example.com/v1"), context(fetch));

		expect(plainUsageUrls(urls)).toEqual(["https://gateway.example.com/api/oauth/usage", CANONICAL_USAGE_URL]);
		expect(report?.metadata?.endpoint).toBe(CANONICAL_USAGE_URL);
	});

	it("keeps retrying a truncated JSON body on the configured host", async () => {
		const { fetch, urls } = recordingFetch(
			() => new Response('{"five_hour":{"utiliz', { status: 200, headers: { "Content-Type": "application/json" } }),
		);

		const report = await claudeUsageProvider.fetchUsage(params("https://mirror.example.com/v1"), context(fetch));

		// A JSON content type that fails to parse is a damaged response from a host
		// that does serve usage — the request must not move.
		expect(report).toBeNull();
		expect(plainUsageUrls(urls)).toEqual(
			Array.from({ length: 3 }, () => "https://mirror.example.com/api/oauth/usage"),
		);
	});

	it("falls back on 501 without spending retries on it", async () => {
		const { fetch, urls } = recordingFetch(url =>
			url === CANONICAL_USAGE_URL
				? jsonResponse(200, USAGE_PAYLOAD)
				: jsonResponse(501, { error: "not_implemented" }),
		);

		const report = await claudeUsageProvider.fetchUsage(params("https://gateway.example.com/v1"), context(fetch));

		// 501 is a 5xx, but "not implemented" is permanent: absence must outrank
		// the generic transient classification.
		expect(plainUsageUrls(urls)).toEqual(["https://gateway.example.com/api/oauth/usage", CANONICAL_USAGE_URL]);
		expect(report?.metadata?.endpoint).toBe(CANONICAL_USAGE_URL);
	});
});

describe("claudeUsageProvider included-billing observation", () => {
	const NOW = 1_800_000_000_000;
	const FIVE_HOUR = { utilization: 17, resets_at: new Date(NOW + 60 * 60_000).toISOString() };

	async function observe(payload: Record<string, unknown>, extra?: Partial<UsageFetchParams>) {
		const { fetch } = recordingFetch(url =>
			url.endsWith("/api/oauth/usage") ? jsonResponse(200, payload) : jsonResponse(404, { error: "not_found" }),
		);
		const report = await claudeUsageProvider.fetchUsage(
			{ ...params(), ...extra, nowMs: NOW } as UsageFetchParams,
			context(fetch),
		);
		const observation = report?.metadata?.routingObservation as RoutingObservation | undefined;
		return { report, observation };
	}

	it("reads explicit spend.enabled true and false from the full response, independent of money fields", async () => {
		const off = await observe({ five_hour: FIVE_HOUR, spend: { enabled: false, used: "garbage" } });
		expect(off.observation?.billing).toEqual({
			state: "disabled",
			observedAt: NOW,
			validUntil: NOW + 300_000,
			source: "claude-usage-spend",
			sourceRevision: null,
		});
		const on = await observe({ five_hour: FIVE_HOUR, spend: { enabled: true, used: { amount_minor: -1 } } });
		expect(on.observation?.billing.state).toBe("enabled");
		expect(on.observation?.billing.observedAt).toBe(NOW);
	});

	it("falls back to the legacy boolean only when spend is null or absent", async () => {
		for (const spend of [null, undefined]) {
			const off = await observe({ five_hour: FIVE_HOUR, spend, extra_usage: { is_enabled: false } });
			expect(off.observation?.billing).toMatchObject({ state: "disabled", source: "claude-usage-legacy" });
			const on = await observe({ five_hour: FIVE_HOUR, spend, extra_usage: { is_enabled: true } });
			expect(on.observation?.billing).toMatchObject({ state: "enabled", source: "claude-usage-legacy" });
		}
	});

	it("treats missing, malformed and conflicting state as unknown", async () => {
		const cases: Array<[Record<string, unknown>, string]> = [
			[{}, "no_evidence"],
			[{ extra_usage: {} }, "no_evidence"],
			[{ spend: {}, extra_usage: { is_enabled: false } }, "malformed"],
			[{ spend: "off", extra_usage: { is_enabled: false } }, "malformed"],
			[{ spend: { enabled: "false" } }, "malformed"],
			[{ extra_usage: { is_enabled: "yes" } }, "malformed"],
			[{ spend: { enabled: false }, extra_usage: { is_enabled: "no" } }, "malformed"],
			[{ spend: { enabled: false }, extra_usage: { is_enabled: true } }, "conflict"],
			[{ spend: { enabled: true }, extra_usage: { is_enabled: false } }, "conflict"],
		];
		for (const [fields, reason] of cases) {
			const { report, observation } = await observe({ five_hour: FIVE_HOUR, ...fields });
			expect(report).not.toBeNull();
			expect(observation?.billing).toMatchObject({ state: "unknown", observedAt: null, validUntil: null, reason });
		}
		const agree = await observe({
			five_hour: FIVE_HOUR,
			spend: { enabled: false },
			extra_usage: { is_enabled: false },
		});
		expect(agree.observation?.billing).toMatchObject({ state: "disabled", source: "claude-usage-spend" });
	});

	it("produces a billing-only report when no quantitative row parses", async () => {
		const { report, observation } = await observe({ spend: { enabled: false } });
		expect(report?.limits).toEqual([]);
		expect(observation?.billing.state).toBe("disabled");
		expect(observation?.windowObservations).toEqual([]);
	});

	it("rejects untrusted endpoints and header-auth credentials", async () => {
		const proxy = await observe(
			{ five_hour: FIVE_HOUR, spend: { enabled: false } },
			params("https://gateway.example.com/v1"),
		);
		expect(proxy.report?.metadata?.endpoint).toBe("https://gateway.example.com/api/oauth/usage");
		expect(proxy.observation?.billing).toMatchObject({ state: "unknown", reason: "untrusted_source" });
		const headerAuth = await observe(
			{ five_hour: FIVE_HOUR, spend: { enabled: false } },
			{ credential: { type: "api_key", apiKey: "sk-ant-oat01-test" } },
		);
		expect(headerAuth.observation?.billing).toMatchObject({ state: "unknown", reason: "untrusted_source" });
	});

	it("compares every identity alias with each other and with the request identity", async () => {
		const base = { five_hour: FIVE_HOUR, spend: { enabled: false } };
		const agreeing = await observe({
			...base,
			account_id: "account_test",
			user: { id: "account_test" },
			email: "USER@example.com",
		});
		expect(agreeing.observation?.billing.state).toBe("disabled");
		expect(agreeing.observation?.accountId).toBe("account_test");
		const aliasConflict = await observe({ ...base, account_id: "account_test", user: { id: "someone_else" } });
		expect(aliasConflict.observation?.billing).toMatchObject({ state: "unknown", reason: "conflict" });
		const requestMismatch = await observe({ ...base, account: { uuid: "other_account" } });
		expect(requestMismatch.observation?.billing).toMatchObject({ state: "unknown", reason: "identity_mismatch" });
		const emailMismatch = await observe({ ...base, email: "other@example.com" });
		expect(emailMismatch.observation?.billing).toMatchObject({ state: "unknown", reason: "identity_mismatch" });
		const orgMismatch = await observe(
			{ ...base, organization_id: "org_b" },
			{ credential: { ...params().credential, orgId: "org_a" } },
		);
		expect(orgMismatch.observation?.billing).toMatchObject({ state: "unknown", reason: "identity_mismatch" });
	});

	it("projects quantitative windows with full-response source and reset-bounded expiry", async () => {
		const resetAt = NOW + 60 * 60_000;
		const { observation } = await observe({ five_hour: FIVE_HOUR, spend: { enabled: false, used: null } });
		expect(observation?.windowObservations).toEqual([
			{
				id: "anthropic:5h",
				label: "Claude 5 Hour",
				scope: { kind: "shared" },
				usedFraction: 0.17,
				resetAt,
				observedAt: NOW,
				validUntil: NOW + 300_000,
				source: "usage-full",
			},
		]);
	});
});
