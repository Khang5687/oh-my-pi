import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AUTH_BROKER_CAPABILITIES_HEADER,
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import * as claudeUsage from "@oh-my-pi/pi-ai/usage/claude";

const NOW = 1_800_000_000_000;
const BASE_URL = "https://api.anthropic.com/v1";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;

interface BrokerCall {
	method: string;
	path: string;
	body: string | null;
}

describe("exact selected-row usage through the broker", () => {
	const token = "exact-bearer";
	const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};
	let serverStore: SqliteAuthCredentialStore;
	let serverStorage: AuthStorage;
	let handle: AuthBrokerServerHandle;
	let remoteStore: RemoteAuthCredentialStore;
	let clientStorage: AuthStorage;
	let brokerNow = NOW;
	let providerCalls: Array<{ bearer: string; signal: AbortSignal | null | undefined }> = [];
	let providerGate: Promise<void> | null = null;
	let providerStatus = 200;
	let brokerCalls: BrokerCall[] = [];
	let stripCapabilities = false;
	let hideExactRoute = false;
	let namespace = "";

	function providerFetch(): typeof fetch {
		return (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url !== USAGE_URL) return new Response("{}", { status: 404 });
			const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /i, "") ?? "";
			providerCalls.push({ bearer, signal: init?.signal });
			if (providerGate) await providerGate;
			if (providerStatus !== 200) return new Response("{}", { status: providerStatus });
			const suffix = bearer.replace(/^access-/, "");
			return new Response(
				JSON.stringify({
					account_id: `account-${suffix}`,
					five_hour: { utilization: 30 },
					seven_day: { utilization: 60 },
					spend: { enabled: false },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;
	}

	function brokerFetch(): typeof fetch {
		return Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
				brokerCalls.push({
					method: init?.method ?? "GET",
					path: url.pathname,
					body: typeof init?.body === "string" ? init.body : null,
				});
				if (hideExactRoute && url.pathname === "/v1/usage/exact") return new Response("{}", { status: 404 });
				const headers = new Headers(init?.headers);
				if (stripCapabilities) headers.delete(AUTH_BROKER_CAPABILITIES_HEADER);
				return fetch(input, { ...init, headers });
			},
			{ preconnect: fetch.preconnect },
		);
	}

	const exactCalls = () => brokerCalls.filter(call => call.path === "/v1/usage/exact");
	const request = (overrides: Record<string, unknown> = {}) => ({
		accountRef: { storeNamespace: namespace, nativeRowId: 1 },
		provider: "anthropic" as const,
		modelId: "claude-sonnet-5-5" as string | null,
		baseUrl: BASE_URL,
		nowMs: NOW,
		...overrides,
	});

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		brokerNow = NOW;
		providerCalls = [];
		providerGate = null;
		providerStatus = 200;
		brokerCalls = [];
		stripCapabilities = false;
		hideExactRoute = false;
		serverStore = new SqliteAuthCredentialStore(new Database(":memory:"));
		for (const suffix of ["1", "2"]) {
			await serverStore.saveOAuth("anthropic", {
				access: `access-${suffix}`,
				refresh: `refresh-${suffix}`,
				expires: Date.now() + 3_600_000,
				accountId: `account-${suffix}`,
				email: `${suffix}@example.com`,
			});
		}
		serverStorage = new AuthStorage(serverStore, {
			usageFetch: providerFetch(),
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await serverStorage.credentials.reload();
		handle = startAuthBroker({
			storage: serverStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
			nowMs: () => brokerNow,
		});
		const client = new AuthBrokerClient({ url: handle.url, token, fetchImpl: brokerFetch(), maxRetries: 0 });
		const snapshot = await client.fetchSnapshot();
		if (snapshot.status !== 200) throw new Error("expected snapshot");
		remoteStore = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: snapshot.snapshot,
			streamSnapshots: false,
		});
		// The client must never reach a provider: any call here is a test failure.
		clientStorage = new AuthStorage(remoteStore, {
			usageFetch: (() => {
				throw new Error("client attempted a provider request");
			}) as unknown as typeof fetch,
		});
		await clientStorage.credentials.reload();
		const source = clientStorage.credentials.routingIdentities({ provider: "anthropic" }).source;
		if (source.status !== "supported") throw new Error("expected supported namespace");
		namespace = source.storeNamespace;
		brokerCalls = [];
	});

	afterEach(async () => {
		clientStorage.close();
		await handle.close();
		serverStorage.close();
		serverStore.close();
		for (const key of ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("a capable broker serves one selected row with one owner-side provider request", async () => {
		const result = await clientStorage.usage.refreshRoutingObservation(request());
		if (result.kind !== "observed") throw new Error(`expected observed, got ${result.code}`);
		expect(result.accountRef).toEqual({ storeNamespace: namespace, nativeRowId: 1 });
		expect(result.observation).toMatchObject({
			storeNamespace: namespace,
			nativeRowId: 1,
			endpoint: USAGE_URL,
			billing: { state: "disabled", observedAt: NOW, validUntil: NOW + 300_000 },
		});
		expect(providerCalls.map(call => call.bearer)).toEqual(["access-1"]);
		expect(brokerCalls.map(call => `${call.method} ${call.path}`)).toEqual(["POST /v1/usage/exact"]);
	});

	test("only metadata identity crosses the broker in either direction", async () => {
		const result = await clientStorage.usage.refreshRoutingObservation(request());
		expect(result.kind).toBe("observed");
		const [call] = exactCalls();
		expect(Object.keys(JSON.parse(call!.body!) as object).sort()).toEqual([
			"baseUrl",
			"modelId",
			"nativeRowId",
			"provider",
			"storeNamespace",
		]);
		expect(JSON.stringify(result)).not.toMatch(/access-|refresh-/);
		expect(call!.body).not.toMatch(/access-|refresh-|\.db|sqlite/i);
	});

	test("two concurrent callers coalesce into one broker call and one provider request", async () => {
		const gate = Promise.withResolvers<void>();
		providerGate = gate.promise;
		const first = clientStorage.usage.refreshRoutingObservation(request());
		const second = clientStorage.usage.refreshRoutingObservation(request());
		await Bun.sleep(50);
		gate.resolve();
		const [a, b] = await Promise.all([first, second]);
		expect(a.kind).toBe("observed");
		expect(b.kind).toBe("observed");
		expect(exactCalls()).toHaveLength(1);
		expect(providerCalls).toHaveLength(1);
	});

	test("caller A cancelling does not cancel caller B", async () => {
		const gate = Promise.withResolvers<void>();
		providerGate = gate.promise;
		const abortA = new AbortController();
		const first = clientStorage.usage.refreshRoutingObservation(request({ signal: abortA.signal }));
		const second = clientStorage.usage.refreshRoutingObservation(request());
		await Bun.sleep(50);
		abortA.abort();
		expect(await first).toEqual({ kind: "unknown", accountRef: request().accountRef, code: "cancelled" });
		expect(providerCalls[0]?.signal?.aborted).toBe(false);
		gate.resolve();
		expect((await second).kind).toBe("observed");
		expect(exactCalls()).toHaveLength(1);
	});

	test("rejects a foreign namespace, row, provider, model and base URL without a provider request", async () => {
		const codes = async (overrides: Record<string, unknown>) => {
			const result = await clientStorage.usage.refreshRoutingObservation(request(overrides));
			return result.kind === "unknown" ? result.code : "observed";
		};
		const foreignNamespace = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
		expect(await codes({ accountRef: { storeNamespace: foreignNamespace, nativeRowId: 1 } })).toBe("source_changed");
		expect(await codes({ accountRef: { storeNamespace: namespace, nativeRowId: 99 } })).toBe("row_unavailable");
		expect(await codes({ accountRef: { storeNamespace: namespace, nativeRowId: 0 } })).toBe("invalid_request");
		expect(await codes({ provider: "openai" })).toBe("invalid_request");
		expect(await codes({ modelId: "" })).toBe("invalid_request");
		expect(await codes({ baseUrl: "https://api.example.com/v1" })).toBe("untrusted_endpoint");
		expect(await codes({ baseUrl: "https://api.anthropic.com.evil.example/v1" })).toBe("untrusted_endpoint");
		expect(await codes({ baseUrl: "https://user:pw@api.anthropic.com/v1" })).toBe("untrusted_endpoint");
		expect(providerCalls).toHaveLength(0);
		expect(exactCalls()).toHaveLength(0);
	});

	test("the broker owner refuses an untrusted base URL, a foreign row and unknown fields sent directly", async () => {
		const post = (body: unknown) =>
			fetch(`${handle.url}/v1/usage/exact`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					[AUTH_BROKER_CAPABILITIES_HEADER]: "source-identity-v1,exact-usage-v1",
				},
				body: JSON.stringify(body),
			});
		const identity = {
			provider: "anthropic",
			storeNamespace: namespace,
			nativeRowId: 1,
			modelId: null,
			baseUrl: BASE_URL,
		};
		const untrusted = await post({ ...identity, baseUrl: "https://collector.example/v1" });
		expect(await untrusted.json()).toMatchObject({ status: "unknown", code: "untrusted_endpoint" });
		const foreign = await post({ ...identity, storeNamespace: "7c9e6679-7425-40de-944b-e07fc1f90ae7" });
		expect(await foreign.json()).toMatchObject({ status: "unknown", code: "source_changed" });
		expect((await post({ ...identity, extra: "x" })).status).toBe(400);
		expect(providerCalls).toHaveLength(0);
	});

	test("a broker without the exact capability yields typed unknown with no aggregate or provider call", async () => {
		stripCapabilities = true;
		const result = await clientStorage.usage.refreshRoutingObservation(request());
		expect(result).toEqual({ kind: "unknown", accountRef: request().accountRef, code: "unsupported" });
		expect(providerCalls).toHaveLength(0);
		expect(brokerCalls.some(call => call.path === "/v1/usage")).toBe(false);

		stripCapabilities = false;
		hideExactRoute = true; // legacy broker: unknown route
		const legacy = await clientStorage.usage.refreshRoutingObservation(request({ nowMs: NOW + 1 }));
		expect(legacy).toEqual({ kind: "unknown", accountRef: request().accountRef, code: "unsupported" });
		expect(brokerCalls.some(call => call.path === "/v1/usage")).toBe(false);
		expect(providerCalls).toHaveLength(0);
	});

	test("an exact read never lists sibling rows or touches /v1/usage", async () => {
		await clientStorage.usage.refreshRoutingObservation(request());
		await clientStorage.usage.refreshRoutingObservation(
			request({ accountRef: { storeNamespace: namespace, nativeRowId: 2 } }),
		);
		expect(providerCalls.map(call => call.bearer)).toEqual(["access-1", "access-2"]);
		expect(brokerCalls.some(call => call.path === "/v1/usage")).toBe(false);
	});

	test("reuses billing until exactly 300000ms, then reads again", async () => {
		await clientStorage.usage.refreshRoutingObservation(request());
		const cached = await clientStorage.usage.refreshRoutingObservation(request({ nowMs: NOW + 299_999 }));
		expect(cached).toMatchObject({ kind: "observed", observation: { billing: { state: "disabled" } } });
		expect(exactCalls()).toHaveLength(1);

		brokerNow = NOW + 300_000;
		const renewed = await clientStorage.usage.refreshRoutingObservation(request({ nowMs: NOW + 300_000 }));
		expect(exactCalls()).toHaveLength(2);
		expect(renewed).toMatchObject({
			kind: "observed",
			observation: { billing: { state: "disabled", observedAt: NOW + 300_000 } },
		});
	});

	test("an expired observation is unknown, not renewed, when the owner cannot re-read it", async () => {
		await clientStorage.usage.refreshRoutingObservation(request());
		providerStatus = 500;
		brokerNow = NOW + 300_000;
		const result = await clientStorage.usage.refreshRoutingObservation(request({ nowMs: NOW + 300_000 }));
		expect(result).toEqual({ kind: "unknown", accountRef: request().accountRef, code: "unavailable" });
	});

	test("the shared read aborts only when its last waiter cancels", async () => {
		const gate = Promise.withResolvers<void>();
		providerGate = gate.promise;
		const abortA = new AbortController();
		const abortB = new AbortController();
		const first = clientStorage.usage.refreshRoutingObservation(request({ signal: abortA.signal }));
		const second = clientStorage.usage.refreshRoutingObservation(request({ signal: abortB.signal }));
		await Bun.sleep(50);
		abortA.abort();
		abortB.abort();
		expect((await first).kind).toBe("unknown");
		expect((await second).kind).toBe("unknown");
		gate.resolve();
		await Bun.sleep(50);
		expect(exactCalls()).toHaveLength(1);
	});

	test("forceRefresh bypasses the cache", async () => {
		await clientStorage.usage.refreshRoutingObservation(request());
		await clientStorage.usage.refreshRoutingObservation(request({ forceRefresh: true }));
		expect(exactCalls()).toHaveLength(2);
	});

	test("a broker response that echoes a different row or model is rejected", async () => {
		const real = brokerFetch();
		const tampering = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const response = await real(input, init);
				if (!String(input).endsWith("/v1/usage/exact")) return response;
				const body = (await response.json()) as object;
				return new Response(JSON.stringify({ ...body, nativeRowId: 2 }), { status: 200 });
			},
			{ preconnect: fetch.preconnect },
		);
		const client = new AuthBrokerClient({ url: handle.url, token, fetchImpl: tampering, maxRetries: 0 });
		const snapshot = await client.fetchSnapshot();
		if (snapshot.status !== 200) throw new Error("expected snapshot");
		const store = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: snapshot.snapshot,
			streamSnapshots: false,
		});
		const storage = new AuthStorage(store);
		try {
			await storage.credentials.reload();
			const result = await storage.usage.refreshRoutingObservation(request());
			expect(result).toEqual({ kind: "unknown", accountRef: request().accountRef, code: "identity_mismatch" });
		} finally {
			storage.close();
		}
	});

	test("peekByCredentialId reads the cache only: no broker call, no provider call", () => {
		const peeked = clientStorage.usage.peekByCredentialId({
			provider: "anthropic",
			credentialId: 1,
			baseUrl: BASE_URL,
		});
		expect(peeked).toBeNull();
		expect(brokerCalls).toHaveLength(0);
		expect(providerCalls).toHaveLength(0);
	});
});
