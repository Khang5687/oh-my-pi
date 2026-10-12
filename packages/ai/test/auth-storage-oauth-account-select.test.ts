import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ManagedResolvedApiKey, withOAuthAccess } from "@oh-my-pi/pi-ai/auth-retry";
import {
	type AccountRef,
	AuthStorage,
	type ManagedAdmissionGrant,
	type ManagedAttemptOutcome,
	type ManagedCallContext,
	type RoutingRefusal,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import * as claudeUsage from "@oh-my-pi/pi-ai/usage/claude";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";

const PROVIDER = "unit-oauth-select";

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `acc-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("AuthStorage OAuth account selection", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-oauth-select-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("oauth.accounts reports stored order, positions, and identity without refreshing", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const refreshSpy = vi.spyOn(oauthUtils, "getOAuthApiKey");
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		const accounts = storage.oauth.accounts(PROVIDER);

		expect(accounts.map(a => a.position)).toEqual([0, 1, 2]);
		expect(accounts.map(a => a.accountId)).toEqual(["acc-a", "acc-b", "acc-c"]);
		expect(accounts.map(a => a.email)).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
		// Read-only: listing must not refresh any token.
		expect(refreshSpy).not.toHaveBeenCalled();
	});

	test("sessions.pin selects and restores the exact stored account", async () => {
		const storage = authStorage;
		const credentialStore = store;
		if (!storage || !credentialStore) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const accounts = storage.oauth.accounts(PROVIDER, "session-pin");
		const target = accounts[1];
		if (!target) throw new Error("expected second OAuth account");

		expect(accounts.some(account => account.active)).toBe(false);
		expect(storage.sessions.pin(PROVIDER, "session-pin", -1)).toBe(false);
		expect(storage.sessions.pin(PROVIDER, "session-pin", target.credentialId)).toBe(true);
		expect(storage.oauth.identity(PROVIDER, "session-pin")?.email).toBe("b@example.com");
		expect(
			storage.oauth
				.accounts(PROVIDER, "session-pin")
				.filter(account => account.active)
				.map(account => account.email),
		).toEqual(["b@example.com"]);
		expect(
			await withOAuthAccess(storage, PROVIDER, access => Promise.resolve(access.email), {
				sessionId: "session-pin",
			}),
		).toBe("b@example.com");

		const restored = new AuthStorage(credentialStore);
		await restored.credentials.reload();
		expect(restored.oauth.identity(PROVIDER, "session-pin")?.email).toBe("b@example.com");
		expect(restored.oauth.accounts(PROVIDER, "session-pin").find(account => account.active)?.credentialId).toBe(
			target.credentialId,
		);
	});

	test("inherited session affinity keeps usage rotation on the selected account", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const accountB = storage.oauth.accounts(PROVIDER)[1];
		if (!accountB) throw new Error("expected second OAuth account");
		expect(storage.sessions.pin(PROVIDER, "parent-session", accountB.credentialId)).toBe(true);

		expect(storage.sessions.inherit("parent-session", "child-session")).toBe(1);
		expect(storage.oauth.accounts(PROVIDER, "child-session").find(account => account.active)?.email).toBe(
			"b@example.com",
		);
		expect(
			await withOAuthAccess(storage, PROVIDER, access => Promise.resolve(access.email), {
				sessionId: "child-session",
			}),
		).toBe("b@example.com");

		const outcome = await storage.limits.markReached(PROVIDER, "child-session", { retryAfterMs: 60_000 });
		expect(outcome.switched).toBe(true);
		expect(
			await withOAuthAccess(storage, PROVIDER, access => Promise.resolve(access.email), {
				sessionId: "child-session",
			}),
		).toBe("a@example.com");
	});

	test("resolves the account at the requested position by ID and touches only that one", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		for (const [position, suffix] of [
			[0, "a"],
			[1, "b"],
			[2, "c"],
		] as const) {
			seen.length = 0;
			const account = storage.oauth.accounts(PROVIDER)[position];
			if (!account) throw new Error("expected OAuth account at position");
			const result = await storage.oauth.accessById(PROVIDER, account.credentialId);
			expect(result?.ok).toBe(true);
			if (!result?.ok) throw new Error("expected ok resolution");
			expect(result.accountId).toBe(`acc-${suffix}`);
			expect(result.accessToken).toBe(`access-${suffix}`);
			// Only the targeted credential is resolved — no sibling is touched.
			expect(seen).toEqual([`access-${suffix}`]);
		}
	});

	test("oauth.accessById force-refreshes only the durable requested row", async () => {
		if (!store) throw new Error("test setup failed");
		const refreshedIds: number[] = [];
		const storage = new AuthStorage(store, {
			refreshOAuthCredential: async (_provider, credentialId, credential) => {
				refreshedIds.push(credentialId);
				return {
					access: `${credential.access}-reminted`,
					refresh: credential.refresh,
					expires: Date.now() + 60 * 60_000,
					accountId: credential.accountId,
					email: credential.email,
				};
			},
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const target = storage.oauth.accounts(PROVIDER)[1];
		if (!target) throw new Error("expected second OAuth account");

		const result = await storage.oauth.accessById(PROVIDER, target.credentialId, { forceRefresh: true });

		expect(result).toMatchObject({
			ok: true,
			credentialId: target.credentialId,
			accountId: "acc-b",
			accessToken: "access-b-reminted",
		});
		expect(refreshedIds).toEqual([target.credentialId]);
		expect(
			store.listAuthCredentials(PROVIDER).map(row => (row.credential.type === "oauth" ? row.credential.access : "")),
		).toEqual(["access-a", "access-b-reminted", "access-c"]);

		// Without forceRefresh the still-fresh row is served as stored.
		const again = await storage.oauth.accessById(PROVIDER, target.credentialId);
		expect(again).toMatchObject({ ok: true, accessToken: "access-b-reminted" });
		expect(refreshedIds).toEqual([target.credentialId]);
	});

	test("oauth.accessById force refresh keeps the requested account when a lower row is removed meanwhile", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store, {
			refreshOAuthCredential: async (_provider, _credentialId, credential) => ({
				...credential,
				access: `${credential.access}-reminted`,
				expires: Date.now() + 60 * 60_000,
			}),
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const [lower, target] = storage.oauth.accounts(PROVIDER);
		if (!lower || !target) throw new Error("expected three OAuth accounts");

		// Another process holds the target's refresh lease and disables the lower row before releasing it,
		// so the forced refresh re-lists the provider's rows without that row.
		expect(store.tryAcquireCredentialRefreshLease(target.credentialId, "peer", Date.now() + 60_000)).toBe(true);
		const pending = storage.oauth.accessById(PROVIDER, target.credentialId, { forceRefresh: true });
		await store.deleteAuthCredential(lower.credentialId, "oauth refresh failed: invalid_grant");
		store.releaseCredentialRefreshLease(target.credentialId, "peer");

		expect(await pending).toMatchObject({
			ok: true,
			credentialId: target.credentialId,
			accountId: "acc-b",
			accessToken: "access-b-reminted",
		});
	});

	test("oauth.accessById auth-recovery force reuses this process's recent mint", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		let mints = 0;
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
			mints += 1;
			return { ...credential, access: `access-b-mint-${mints}`, expires: Date.now() + 60 * 60_000 };
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const target = storage.oauth.accounts(PROVIDER)[1];
		if (!target) throw new Error("expected second OAuth account");
		const recovery = { forceRefresh: true, refreshReason: "auth-recovery" as const };

		expect(await storage.oauth.accessById(PROVIDER, target.credentialId, recovery)).toMatchObject({
			accessToken: "access-b-mint-1",
		});
		expect(await storage.oauth.accessById(PROVIDER, target.credentialId, recovery)).toMatchObject({
			accessToken: "access-b-mint-1",
		});
		expect(mints).toBe(1);
		// A generic forced refresh still mints.
		expect(await storage.oauth.accessById(PROVIDER, target.credentialId, { forceRefresh: true })).toMatchObject({
			accessToken: "access-b-mint-2",
		});
	});

	test("resolving the selected account by ID fails without touching siblings", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		// The targeted account (acc-b) fails definitively; siblings would refresh fine.
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			if (credential.access === "access-b") throw new Error("invalid_grant");
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		const account = storage.oauth.accounts(PROVIDER)[1];
		if (!account) throw new Error("expected second OAuth account");
		const result = await storage.oauth.accessById(PROVIDER, account.credentialId);

		expect(result?.ok).toBe(false);
		if (!result || result.ok) throw new Error("expected failed resolution");
		// Reports the requested account, never a sibling's token.
		expect(result.accountId).toBe("acc-b");
		expect("accessToken" in result).toBe(false);
		// Target-only: no sibling credential was refreshed/rotated on the failure path.
		expect(seen).toEqual(["access-b"]);
	});
});

describe("AuthStorage.routing strict exact-row resolution", () => {
	const NOW = 1_800_000_000_000;
	const BASE_URL = "https://api.anthropic.com/v1";
	const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
	const MODEL = "claude-sonnet-5-5";
	const ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
	const savedEnv: Record<string, string | undefined> = {};
	let dir = "";
	let credentialStore: SqliteAuthCredentialStore;
	let storage: AuthStorage;
	let clock = NOW;
	let usageBody: (bearer: string) => Record<string, unknown>;
	let usageGate: Promise<void> | null = null;
	let usageBearers: string[] = [];
	let namespace = "";
	let started: Array<{ grant: ManagedAdmissionGrant; at: number }> = [];
	let outcomes: Array<{ grant: ManagedAdmissionGrant; outcome: ManagedAttemptOutcome }> = [];
	let configured = true;

	const lifecycle = {
		isConfigured: () => configured,
		started: (grant: ManagedAdmissionGrant, at: number) => started.push({ grant, at }),
		outcome: (grant: ManagedAdmissionGrant, outcome: ManagedAttemptOutcome) => outcomes.push({ grant, outcome }),
	};

	function ref(nativeRowId: number): AccountRef {
		return { storeNamespace: namespace, nativeRowId };
	}
	function call(signal?: AbortSignal): ManagedCallContext {
		return {
			operationId: "op-1",
			requestGeneration: 1,
			sessionId: "s",
			modelId: MODEL,
			purpose: "agent_turn",
			replayPolicy: "no_replay",
			signal,
		};
	}
	function grant(accountRef: AccountRef): ManagedAdmissionGrant {
		return {
			hostEpoch: "epoch",
			runtimeInstanceId: "rt",
			admissionId: "adm",
			selectionGeneration: 1,
			policyRevision: 1,
			accountRef,
			operationId: "op-1",
			attemptId: "att-1",
			requestGeneration: 1,
			sessionId: "s",
			modelId: MODEL,
			purpose: "agent_turn",
		};
	}
	function resolve(row: number, signal?: AbortSignal, accountRef: AccountRef = ref(row)) {
		return storage.routing.resolveExact({
			accountRef,
			modelId: MODEL,
			baseUrl: BASE_URL,
			admission: grant(accountRef),
			call: call(signal),
			lifecycle,
			signal,
		});
	}
	const refused = (result: ManagedResolvedApiKey | RoutingRefusal): RoutingRefusal => {
		if (!("refusal" in result)) throw new Error("expected refusal");
		return result;
	};

	beforeEach(async () => {
		for (const key of ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-routing-"));
		credentialStore = await SqliteAuthCredentialStore.open(path.join(dir, "agent.db"));
		clock = NOW;
		usageGate = null;
		usageBearers = [];
		started = [];
		outcomes = [];
		configured = true;
		usageBody = () => ({ five_hour: { utilization: 30 }, seven_day: { utilization: 40 }, spend: { enabled: false } });
		const usageFetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url !== USAGE_URL) return new Response("{}", { status: 404 });
			const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /i, "") ?? "";
			usageBearers.push(bearer);
			if (usageGate) await usageGate;
			return new Response(JSON.stringify(usageBody(bearer)), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;
		storage = new AuthStorage(credentialStore, {
			usageFetch,
			routingClock: () => clock,
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		const credentials = ["a", "b", "c"].map(suffix => ({ ...oauthCredential(suffix) }));
		await storage.credentials.set("anthropic", credentials);
		const source = storage.credentials.routingIdentities({ provider: "anthropic" }).source;
		if (source.status !== "supported") throw new Error("expected supported namespace");
		namespace = source.storeNamespace;
	});

	afterEach(async () => {
		credentialStore.close();
		await fs.rm(dir, { recursive: true, force: true });
		for (const key of ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	const rowId = (suffix: string): number => {
		const account = storage.credentials
			.routingIdentities({ provider: "anthropic" })
			.accounts.find(candidate => candidate.accountId === `acc-${suffix}`);
		if (!account) throw new Error(`no row ${suffix}`);
		return account.ref.nativeRowId;
	};

	test("resolves exactly the granted row with its own bearer and serving account identity", async () => {
		const b = rowId("b");
		const result = await resolve(b);
		if ("refusal" in result) throw new Error(`refused: ${result.code}`);
		expect(result.apiKey).toBe("access-b");
		expect(result.credentialId).toBe(b);
		expect(result.oauthIdentity?.accountId).toBe("acc-b");
		expect(usageBearers).toEqual(["access-b"]);
		await result.managedAdmission.beforeDispatch();
		result.managedAdmission.started(NOW);
		expect(started.map(entry => entry.grant.attemptId)).toEqual(["att-1"]);
		expect(outcomes).toHaveLength(0);
	});

	test("billing enabled refuses with exactly one resolution_refused outcome and no bearer", async () => {
		usageBody = () => ({ five_hour: { utilization: 1 }, spend: { enabled: true } });
		const refusal = refused(await resolve(rowId("a")));
		expect(refusal.code).toBe("billing_enabled");
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]?.outcome).toMatchObject({
			code: "resolution_refused",
			startedAt: null,
			dispatch: "not_dispatched",
			refusalReason: "billing_enabled",
		});
		expect(started).toHaveLength(0);
	});

	test("missing billing evidence is unknown, never assumed included", async () => {
		usageBody = () => ({ five_hour: { utilization: 1 } });
		expect(refused(await resolve(rowId("a"))).code).toBe("billing_unknown");
	});

	test("confirmed exhaustion of an applicable window refuses quota_blocked with the reset delay", async () => {
		const resetAt = new Date(NOW + 90 * 60_000).toISOString();
		usageBody = () => ({
			five_hour: { utilization: 100, resets_at: resetAt },
			seven_day: { utilization: 10 },
			spend: { enabled: false },
		});
		const refusal = refused(await resolve(rowId("a")));
		expect(refusal.code).toBe("quota_blocked");
		expect(refusal.retryAfterMs).toBe(90 * 60_000);
	});

	test("the row deleted and compacted during the refresh never retargets a sibling", async () => {
		const a = rowId("a");
		const gate = Promise.withResolvers<void>();
		usageGate = gate.promise;
		const pending = resolve(a);
		await Bun.sleep(30);
		await credentialStore.deleteAuthCredential(a, "test");
		await storage.credentials.reload();
		gate.resolve();
		const refusal = refused(await pending);
		expect(refusal.code).toBe("no_account");
		expect(usageBearers).not.toContain("access-b");
		expect(usageBearers).not.toContain("access-c");
	});

	test("billing evidence expiring before dispatch revokes the grant at beforeDispatch", async () => {
		const result = await resolve(rowId("a"));
		if ("refusal" in result) throw new Error("expected bearer");
		clock = NOW + 300_001;
		await expect(result.managedAdmission.beforeDispatch()).rejects.toMatchObject({ code: "billing_unknown" });
	});

	test("a host epoch change or cancellation revokes the grant at beforeDispatch", async () => {
		const result = await resolve(rowId("a"));
		if ("refusal" in result) throw new Error("expected bearer");
		configured = false;
		await expect(result.managedAdmission.beforeDispatch()).rejects.toMatchObject({ code: "host_unavailable" });
		configured = true;
		const controller = new AbortController();
		controller.abort();
		await expect(result.managedAdmission.beforeDispatch(controller.signal)).rejects.toMatchObject({
			code: "cancelled",
		});
	});

	test("a static key override, foreign namespace, untrusted base URL and abort refuse without a provider request", async () => {
		const a = rowId("a");
		storage.keys.setRuntime("anthropic", "sk-ant-api-runtime");
		expect(refused(await resolve(a)).code).toBe("auth_unavailable");
		storage.keys.removeRuntime("anthropic");
		const foreign = { storeNamespace: "7c9e6679-7425-40de-944b-e07fc1f90ae7", nativeRowId: a };
		expect(refused(await resolve(a, undefined, foreign)).code).toBe("source_changed");
		const untrusted = await storage.routing.resolveExact({
			accountRef: ref(a),
			modelId: MODEL,
			baseUrl: "https://api.example.com/v1",
			admission: grant(ref(a)),
			call: call(),
			lifecycle,
		});
		expect(refused(untrusted).code).toBe("unsupported_transport");
		const controller = new AbortController();
		controller.abort();
		expect(refused(await resolve(a, controller.signal)).code).toBe("cancelled");
		expect(usageBearers).toHaveLength(0);
		expect(outcomes.every(entry => entry.outcome.startedAt === null)).toBe(true);
	});

	test("an unknown row id refuses no_account", async () => {
		expect(refused(await resolve(999)).code).toBe("no_account");
	});
});
