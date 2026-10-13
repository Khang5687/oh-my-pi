import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { AuthStorage, type OAuthLoginExisting, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthPrompt } from "@oh-my-pi/pi-ai/registry/oauth/types";

const SOURCE = "login-existing-test";
const PROVIDER = "login-existing-provider";

// Synthetic accounts only; no real credential store is read.
let nextLogin: { accountId: string; email: string; access: string };

function readRows(db: Database): Array<{ id: number; data: string; disabled_cause: string | null }> {
	return db
		.query("SELECT id, data, disabled_cause FROM auth_credentials WHERE provider = ? ORDER BY id ASC")
		.all(PROVIDER) as Array<{ id: number; data: string; disabled_cause: string | null }>;
}

describe("AuthStorage.oauth.login existing-credential guard", () => {
	let db: Database;
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		db = new Database(":memory:");
		store = new SqliteAuthCredentialStore(db);
		storage = new AuthStorage(store);
		await storage.credentials.reload();
		registerOAuthProvider({
			id: PROVIDER,
			name: "Login existing test",
			sourceId: SOURCE,
			async login() {
				return {
					access: nextLogin.access,
					refresh: `refresh-${nextLogin.access}`,
					expires: Date.now() + 3_600_000,
					accountId: nextLogin.accountId,
					email: nextLogin.email,
				};
			},
		});
	});

	afterEach(() => {
		unregisterOAuthProviders(SOURCE);
		store.close();
	});

	async function login(account: "a" | "b", access: string, existing?: OAuthLoginExisting) {
		nextLogin = { accountId: `acct-${account}`, email: `${account}@example.test`, access };
		return storage.oauth.login(PROVIDER, {
			onAuth: () => {},
			onPrompt: async () => "",
			...(existing === undefined ? {} : { existing }),
		});
	}

	it("refuse on a same-identity match writes nothing and names the existing row", async () => {
		const first = await login("a", "access-a1");
		const before = readRows(db);

		const refused = await login("a", "access-a2", "refuse").catch((error: unknown) => error);

		expect(refused).toBeInstanceOf(AIError.CredentialExistsError);
		const conflict = refused as AIError.CredentialExistsError;
		expect(conflict.rowId).toBe(first?.rowId as number);
		expect(conflict.email).toBe("a@example.test");
		expect(conflict.message).not.toContain("access-a2");
		// The stored grant is untouched: same rows, same token bytes.
		expect(readRows(db)).toEqual(before);
		expect(before[0].data).toContain("access-a1");
		expect((await storage.oauth.access(PROVIDER))?.accessToken).toBe("access-a1");
	});

	it("refuse without a match adds a new row and reports it", async () => {
		const first = await login("a", "access-a1");
		const added = await login("b", "access-b1", "refuse");

		expect(first).toMatchObject({ outcome: "added", rowId: expect.any(Number) });
		expect(added).toMatchObject({ outcome: "added", email: "b@example.test" });
		expect(added?.rowId).not.toBe(first?.rowId);
		expect(readRows(db).map(row => row.id)).toEqual([first?.rowId as number, added?.rowId as number]);
	});

	it("replaceRowId replaces the named row and reports it", async () => {
		const first = await login("a", "access-a1");
		const replaced = await login("a", "access-a2", { replaceRowId: first?.rowId as number });

		expect(replaced).toMatchObject({ outcome: "replaced", rowId: first?.rowId, email: "a@example.test" });
		const rows = readRows(db);
		expect(rows).toHaveLength(1);
		expect(rows[0].data).toContain("access-a2");
	});

	it("replaceRowId refuses when the match is a different row", async () => {
		const a = await login("a", "access-a1");
		const b = await login("b", "access-b1");
		const before = readRows(db);

		const refused = await login("a", "access-a2", { replaceRowId: b?.rowId as number }).catch(
			(error: unknown) => error,
		);

		expect(refused).toBeInstanceOf(AIError.CredentialExistsError);
		expect((refused as AIError.CredentialExistsError).rowId).toBe(a?.rowId as number);
		expect(readRows(db)).toEqual(before);
	});

	it("replaceRowId adds when no row matches", async () => {
		const a = await login("a", "access-a1");
		const added = await login("b", "access-b1", { replaceRowId: a?.rowId as number });

		expect(added).toMatchObject({ outcome: "added" });
		expect(readRows(db)).toHaveLength(2);
		expect(readRows(db)[0].data).toContain("access-a1");
	});

	it("absent existing keeps today's replace and reports it", async () => {
		const first = await login("a", "access-a1");
		const again = await login("a", "access-a2");

		expect(again).toMatchObject({ outcome: "replaced", rowId: first?.rowId });
		expect(readRows(db)[0].data).toContain("access-a2");
	});
});

describe("AuthStorage.oauth.login paste-code prompt", () => {
	it("hands the prompt a signal that aborts once the flow settles", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.credentials.reload();
		let authUrl = "";
		let prompt: OAuthPrompt | undefined;
		try {
			await storage.oauth.login("gitlab-duo-agent", {
				onAuth: info => {
					authUrl = info.url;
				},
				onPrompt: async received => {
					prompt = received;
					const state = new URL(authUrl).searchParams.get("state");
					return `vscode://gitlab.gitlab-workflow/authentication?code=manual-code&state=${state}`;
				},
				fetch: async () =>
					new Response(
						JSON.stringify({ access_token: "synthetic", refresh_token: "synthetic-r", expires_in: 3600 }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			});
		} finally {
			store.close();
		}
		expect(prompt?.signal).toBeInstanceOf(AbortSignal);
		expect(prompt?.signal?.aborted).toBe(true);
	});
});
