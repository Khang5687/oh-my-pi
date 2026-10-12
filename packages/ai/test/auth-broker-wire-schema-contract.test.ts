import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Type, type } from "@oh-my-pi/omptype";
import * as wireSchemas from "@oh-my-pi/pi-ai/auth-broker/wire-schemas";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const REFRESHER = {
	enabled: false,
	intervalMs: 60_000,
	skewMs: 300_000,
	nextSweepInMs: Number.MAX_SAFE_INTEGER,
};
const BLOCK = {
	providerKey: "anthropic:oauth",
	blockScope: "tier:fable",
	blockedUntilMs: 4_000,
	updatedAtMs: 3_000,
};
const REMOTE_OAUTH = {
	type: "oauth",
	access: "access",
	refresh: "__remote__",
	expires: 5_000,
	tokenUrl: "https://example.test/token",
	clientId: "provider-client",
};
const REAL_OAUTH = { ...REMOTE_OAUTH, refresh: "real-refresh" };
const API_KEY = { type: "api_key", key: "secret", source: "login" };
const CREDENTIAL_ENTRY = {
	id: 7,
	provider: "anthropic",
	credential: REMOTE_OAUTH,
	identityKey: "account:test",
};
const SNAPSHOT_ENTRY = {
	...CREDENTIAL_ENTRY,
	rotatesInMs: null,
	blocks: [BLOCK],
};
const SNAPSHOT = {
	generation: 2,
	generatedAt: 1_000,
	serverNowMs: 2_000,
	refresher: REFRESHER,
	credentials: [SNAPSHOT_ENTRY],
};
const STREAM_SNAPSHOT = { kind: "snapshot", ...SNAPSHOT };
const STREAM_ENTRY = {
	kind: "entry",
	generation: 3,
	serverNowMs: 2_500,
	refresher: REFRESHER,
	entry: SNAPSHOT_ENTRY,
};
const STREAM_REMOVED = {
	kind: "removed",
	generation: 4,
	serverNowMs: 3_000,
	refresher: REFRESHER,
	id: 7,
};
const USAGE_REPORT = {
	provider: "anthropic",
	fetchedAt: 2_000,
	limits: [
		{
			id: "rolling",
			label: "Rolling window",
			scope: {
				provider: "anthropic",
				windowId: "rolling",
				shared: true,
				sharedGroup: "3p:rolling",
				providerExtension: true,
			},
			window: { id: "rolling", label: "5 hour", durationMs: 18_000_000 },
			amount: { used: 1, limit: 10, remaining: 9, unit: "tokens", providerExtension: "kept" },
			status: "ok",
			notes: ["limit note"],
			providerExtension: 1,
		},
	],
	notes: ["report note"],
	metadata: { plan: "max" },
	raw: { providerPayload: true },
	providerExtension: "kept",
};
const OBSERVED_USAGE = {
	at: 1_000,
	provider: "anthropic",
	model: "claude",
	requests: 1,
	inputTokens: 2,
	outputTokens: 3,
	cacheReadTokens: 4,
	cacheWriteTokens: 5,
	costUsd: 0.01,
};

const schemaNames = [
	"oauthCredentialSchema",
	"remoteOauthCredentialSchema",
	"apiKeyCredentialSchema",
	"writableAuthCredentialSchema",
	"snapshotCredentialSchema",
	"credentialSnapshotEntrySchema",
	"credentialBlockSnapshotSchema",
	"snapshotEntrySchema",
	"refresherScheduleSchema",
	"snapshotResponseSchema",
	"snapshotStreamSnapshotEventSchema",
	"snapshotStreamEntryEventSchema",
	"snapshotStreamRemovedEventSchema",
	"snapshotStreamEventSchema",
	"healthzResponseSchema",
	"usageResponseSchema",
	"usageHistoryResponseSchema",
	"clientUsageReportRequestSchema",
	"clientUsageReportResponseSchema",
	"clientUsageSummaryResponseSchema",
	"credentialRefreshResponseSchema",
	"credentialDisableRequestSchema",
	"credentialDisableResponseSchema",
	"disabledCredentialSummarySchema",
	"disabledCredentialsResponseSchema",
	"credentialBlockRequestSchema",
	"credentialBlockDeleteRequestSchema",
	"credentialBlockResponseSchema",
	"credentialBlocksDeleteResponseSchema",
	"usageStaleResponseSchema",
	"credentialUploadRequestSchema",
	"credentialUploadResponseSchema",
] as const;

type SchemaName = (typeof schemaNames)[number];
type CallableSchema = (input: unknown) => unknown;

const validSamples: Record<SchemaName, unknown> = {
	oauthCredentialSchema: REAL_OAUTH,
	remoteOauthCredentialSchema: REMOTE_OAUTH,
	apiKeyCredentialSchema: API_KEY,
	writableAuthCredentialSchema: REAL_OAUTH,
	snapshotCredentialSchema: REMOTE_OAUTH,
	credentialSnapshotEntrySchema: CREDENTIAL_ENTRY,
	credentialBlockSnapshotSchema: BLOCK,
	snapshotEntrySchema: SNAPSHOT_ENTRY,
	refresherScheduleSchema: REFRESHER,
	snapshotResponseSchema: SNAPSHOT,
	snapshotStreamSnapshotEventSchema: STREAM_SNAPSHOT,
	snapshotStreamEntryEventSchema: STREAM_ENTRY,
	snapshotStreamRemovedEventSchema: STREAM_REMOVED,
	snapshotStreamEventSchema: STREAM_ENTRY,
	healthzResponseSchema: { ok: true, version: "contract" },
	usageResponseSchema: { generatedAt: 2_000, reports: [USAGE_REPORT] },
	usageHistoryResponseSchema: {
		generatedAt: 2_000,
		entries: [
			{
				recordedAt: 1_000,
				provider: "anthropic",
				accountKey: "account:test",
				limitId: "rolling",
				label: "Rolling window",
				usedFraction: 0.1,
				status: "ok",
			},
		],
	},
	clientUsageReportRequestSchema: { installId: "install", hostname: "host", app: "robomp", entries: [OBSERVED_USAGE] },
	clientUsageReportResponseSchema: { ok: true },
	clientUsageSummaryResponseSchema: {
		generatedAt: 2_000,
		clients: [
			{
				installId: "install",
				hostname: "host",
				firstSeen: 1_000,
				lastSeen: 2_000,
				providers: [{ ...OBSERVED_USAGE, app: "robomp", firstSeen: undefined, at: undefined, model: undefined }],
			},
		],
	},
	credentialRefreshResponseSchema: { entry: CREDENTIAL_ENTRY },
	credentialDisableRequestSchema: {},
	credentialDisableResponseSchema: { ok: true },
	disabledCredentialSummarySchema: {
		id: 7,
		provider: "anthropic",
		type: "oauth",
		email: "user@example.test",
		cause: "revoked",
		disabledAtMs: 2_000,
	},
	disabledCredentialsResponseSchema: {
		generatedAt: 2_000,
		disabled: [{ id: 7, provider: "anthropic", type: "oauth", cause: "revoked" }],
	},
	credentialBlockRequestSchema: BLOCK,
	credentialBlockDeleteRequestSchema: { providerKey: BLOCK.providerKey, blockScope: BLOCK.blockScope },
	credentialBlockResponseSchema: { ok: true },
	credentialBlocksDeleteResponseSchema: { ok: true },
	usageStaleResponseSchema: { ok: true },
	credentialUploadRequestSchema: { provider: "anthropic", credential: REAL_OAUTH },
	credentialUploadResponseSchema: { entries: [CREDENTIAL_ENTRY] },
};

function run(schema: unknown, input: unknown): unknown {
	return (schema as CallableSchema)(input);
}

function accept(schema: unknown, input: unknown): unknown {
	const result = run(schema, input);
	expect(result).not.toBeInstanceOf(type.errors);
	if (result instanceof type.errors) throw new Error(`Expected schema acceptance: ${result.summary}`);
	return result;
}

function reject(schema: unknown, input: unknown): void {
	expect(run(schema, input)).toBeInstanceOf(type.errors);
}

describe("auth-broker public wire schemas", () => {
	test("exports all 32 real callable ArkType values with canonical behavior", () => {
		expect(Object.keys(wireSchemas).sort()).toEqual([...schemaNames].sort());
		for (const name of schemaNames) {
			const schema = wireSchemas[name];
			expect(typeof schema).toBe("function");
			expect(schema).toBeInstanceOf(Type);
			accept(schema, validSamples[name]);
		}
	});

	test("preserves credential extension and sentinel boundaries", () => {
		expect(accept(wireSchemas.oauthCredentialSchema, REAL_OAUTH)).toEqual(REAL_OAUTH);
		expect(accept(wireSchemas.remoteOauthCredentialSchema, REMOTE_OAUTH)).toEqual(REMOTE_OAUTH);
		reject(wireSchemas.oauthCredentialSchema, REMOTE_OAUTH);
		reject(wireSchemas.remoteOauthCredentialSchema, REAL_OAUTH);
		reject(wireSchemas.oauthCredentialSchema, { ...REAL_OAUTH, access: "" });
		reject(wireSchemas.apiKeyCredentialSchema, { ...API_KEY, extra: true });
		reject(wireSchemas.apiKeyCredentialSchema, { ...API_KEY, source: "environment" });
		reject(wireSchemas.credentialUploadRequestSchema, { provider: "", credential: REAL_OAUTH });
	});

	test("preserves fixed envelopes, integer fields, discriminators, and block alias identity", () => {
		expect(wireSchemas.credentialBlockRequestSchema).toBe(wireSchemas.credentialBlockSnapshotSchema);
		accept(wireSchemas.credentialBlockRequestSchema, {
			providerKey: BLOCK.providerKey,
			blockScope: "",
			blockedUntilMs: BLOCK.blockedUntilMs,
		});
		// Empty scope addresses the global row; a missing provider key or extra field must not widen the delete.
		accept(wireSchemas.credentialBlockDeleteRequestSchema, { providerKey: BLOCK.providerKey, blockScope: "" });
		reject(wireSchemas.credentialBlockDeleteRequestSchema, { providerKey: "", blockScope: "" });
		reject(wireSchemas.credentialBlockDeleteRequestSchema, { ...BLOCK });
		accept(wireSchemas.credentialDisableRequestSchema, {});
		reject(wireSchemas.credentialDisableRequestSchema, { cause: 1 });
		reject(wireSchemas.credentialDisableRequestSchema, { extra: true });
		reject(wireSchemas.healthzResponseSchema, { ok: true, extra: true });
		reject(wireSchemas.snapshotResponseSchema, { ...SNAPSHOT, generation: 1.5 });
		reject(wireSchemas.snapshotResponseSchema, { ...SNAPSHOT, extra: true });
		reject(wireSchemas.snapshotEntrySchema, { ...SNAPSHOT_ENTRY, id: 1.5 });
		reject(wireSchemas.snapshotStreamEventSchema, { ...STREAM_ENTRY, kind: "snapshot" });
		reject(wireSchemas.snapshotStreamEventSchema, { ...STREAM_REMOVED, extra: true });
		reject(wireSchemas.snapshotStreamEventSchema, { kind: "unknown" });
	});

	test("preserves usage extensions while rejecting envelope and enum violations", () => {
		const response = { generatedAt: 2_000, reports: [USAGE_REPORT] };
		expect(accept(wireSchemas.usageResponseSchema, response)).toEqual(response);
		reject(wireSchemas.usageResponseSchema, { ...response, extra: true });
		reject(wireSchemas.usageResponseSchema, {
			...response,
			reports: [{ ...USAGE_REPORT, limits: [{ ...USAGE_REPORT.limits[0], amount: { unit: "seconds" } }] }],
		});
		reject(wireSchemas.usageResponseSchema, {
			...response,
			reports: [{ ...USAGE_REPORT, limits: [{ ...USAGE_REPORT.limits[0], status: "critical" }] }],
		});
	});
});

const NAMESPACE = "6f1c2a4e-8b3d-4e5f-9a7b-0c1d2e3f4a5b";

describe("source identity wire fields", () => {
	test("accepts an optional namespace on snapshots and deltas and rejects an empty one", () => {
		accept(wireSchemas.snapshotResponseSchema, { ...SNAPSHOT, storeNamespace: NAMESPACE });
		accept(wireSchemas.snapshotStreamEventSchema, { ...STREAM_SNAPSHOT, storeNamespace: NAMESPACE });
		accept(wireSchemas.snapshotStreamEventSchema, { ...STREAM_ENTRY, storeNamespace: NAMESPACE });
		accept(wireSchemas.snapshotStreamEventSchema, { ...STREAM_REMOVED, storeNamespace: NAMESPACE });
		reject(wireSchemas.snapshotResponseSchema, { ...SNAPSHOT, storeNamespace: "" });
		reject(wireSchemas.snapshotStreamEventSchema, { ...STREAM_ENTRY, storeNamespace: 7 });
	});
});

function oauth(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("SQLite source namespace", () => {
	let tempDir = "";
	const opened: SqliteAuthCredentialStore[] = [];
	const open = async (file: string): Promise<SqliteAuthCredentialStore> => {
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, file));
		opened.push(store);
		return store;
	};
	const closeAll = (): void => {
		for (const store of opened.splice(0)) store.close();
	};
	const withRaw = <T>(file: string, fn: (db: Database) => T): T => {
		const db = new Database(path.join(tempDir, file));
		try {
			return fn(db);
		} finally {
			db.close();
		}
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-source-identity-"));
	});

	afterEach(async () => {
		closeAll();
		vi.restoreAllMocks();
		await removeWithRetries(tempDir);
	});

	test("concurrent opens converge on one namespace that survives reopen", async () => {
		const stores = await Promise.all([1, 2, 3, 4].map(() => open("agent.db")));
		const identities = stores.map(store => store.routingSourceIdentity());
		expect(identities[0]?.status).toBe("supported");
		expect(new Set(identities.map(identity => identity.storeNamespace)).size).toBe(1);
		closeAll();

		const reopened = await open("agent.db");
		expect(reopened.routingSourceIdentity()).toEqual(identities[0]!);
	});

	test("a database with no namespace row gets exactly one on first open", async () => {
		await open("legacy.db");
		closeAll();
		withRaw("legacy.db", db => db.run("DELETE FROM auth_routing_source_identity"));

		const migrated = await open("legacy.db");
		expect(migrated.routingSourceIdentity().status).toBe("supported");
		expect(
			withRaw("legacy.db", db => db.query("SELECT COUNT(*) AS n FROM auth_routing_source_identity").get()),
		).toEqual({
			n: 1,
		});
	});

	test("a malformed stored namespace is unsupported and is never regenerated", async () => {
		await open("corrupt.db");
		closeAll();
		for (const bad of ["not-a-uuid", NAMESPACE.toUpperCase()]) {
			withRaw("corrupt.db", db => db.run("UPDATE auth_routing_source_identity SET store_namespace = ?", [bad]));

			const store = await open("corrupt.db");
			expect(store.routingSourceIdentity()).toEqual({
				status: "unsupported",
				storeNamespace: null,
				reason: "namespace_unavailable",
			});
			closeAll();
			expect(
				withRaw("corrupt.db", db => db.query("SELECT store_namespace FROM auth_routing_source_identity").get()),
			).toEqual({ store_namespace: bad });
		}
	});

	test("separate stores with identical row ids yield different refs", async () => {
		const [a, b] = [await open("a.db"), await open("b.db")];
		await a.upsertAuthCredential("anthropic", oauth("one"));
		await b.upsertAuthCredential("anthropic", oauth("one"));
		const storageA = new AuthStorage(a);
		const storageB = new AuthStorage(b);
		await storageA.credentials.reload();
		await storageB.credentials.reload();

		const refA = storageA.credentials.routingIdentities({ provider: "anthropic" }).accounts[0]!.ref;
		const refB = storageB.credentials.routingIdentities({ provider: "anthropic" }).accounts[0]!.ref;
		expect(refA.nativeRowId).toBe(refB.nativeRowId);
		expect(refA.storeNamespace).not.toBe(refB.storeNamespace);
	});

	test("catalog is incomplete until a reload finishes and again after one fails", async () => {
		const store = await open("agent.db");
		await store.upsertAuthCredential("anthropic", oauth("one"));
		const storage = new AuthStorage(store);

		const before = storage.credentials.routingIdentities({ provider: "anthropic" });
		expect(before).toMatchObject({ authoritativeComplete: false, authoritativeObservedAt: null, accounts: [] });

		await storage.credentials.reload();
		const loaded = storage.credentials.routingIdentities({ provider: "anthropic" });
		expect(loaded.authoritativeComplete).toBe(true);
		expect(loaded.authoritativeObservedAt).toBeGreaterThan(0);
		expect(loaded.accounts).toHaveLength(1);

		vi.spyOn(store, "listAuthCredentials").mockImplementation(() => {
			throw new Error("db unavailable");
		});
		await expect(storage.credentials.reload()).rejects.toThrow("db unavailable");
		const failed = storage.credentials.routingIdentities({ provider: "anthropic" });
		expect(failed.authoritativeComplete).toBe(false);
		expect(failed.authoritativeObservedAt).toBeNull();
	});

	test("namespace-less source reports unsupported with no refs, and no result carries credential material", async () => {
		const store = await open("agent.db");
		await store.upsertAuthCredential("anthropic", oauth("secret"));
		const storage = new AuthStorage(store);
		await storage.credentials.reload();

		const supported = storage.credentials.routingIdentities({ provider: "anthropic" });
		expect(JSON.stringify(supported)).not.toMatch(/access-secret|refresh-secret|agent\.db/);
		expect(Object.keys(supported.accounts[0]!).sort()).toEqual([
			"accountId",
			"credentialAvailable",
			"email",
			"organizationId",
			"organizationName",
			"provider",
			"ref",
		]);

		vi.spyOn(store, "routingSourceIdentity").mockReturnValue({
			status: "unsupported",
			storeNamespace: null,
			reason: "namespace_unavailable",
		});
		const unsupported = storage.credentials.routingIdentities({ provider: "anthropic" });
		expect(unsupported.source).toEqual({
			status: "unsupported",
			storeNamespace: null,
			reason: "namespace_unavailable",
		});
		expect(unsupported.accounts).toEqual([]);
		expect(unsupported.authoritativeComplete).toBe(false);
		// Refusing to mint refs must not delete the local rows.
		expect(storage.credentials.list("anthropic")).toHaveLength(1);
	});
});
