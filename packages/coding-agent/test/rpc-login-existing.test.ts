import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

// Offline extension provider. Its OAuth login returns a synthetic credential for the
// account named in the input title, so the test picks the account per login.
// fetchDynamicModels appends every key it is handed to a file: that is how the test
// sees which credential a post-login model refresh used.
const extensionSource = (keysPath: string) => `
import * as fs from "node:fs";
export default function(pi) {
  globalThis.fetch = async () => { throw new Error("Offline login fixture refuses network"); };
  const credential = account => ({
    access: "access-" + account + "-" + crypto.randomUUID(),
    refresh: "refresh-" + account,
    expires: Date.now() + 3_600_000,
    accountId: "acct-" + account,
    email: account + "@example.test",
  });
  const config = (login) => ({
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    models: [{ id: "fixture", name: "Offline fixture", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    fetchDynamicModels: async key => { fs.appendFileSync(${JSON.stringify(keysPath)}, (key ?? "none") + "\\n"); return []; },
    oauth: { name: "guard", login },
  });
  pi.registerProvider("rpc-guard", config(async callbacks => {
    callbacks.onAuth({ url: "https://example.invalid/authorize" });
    return credential(await callbacks.onPrompt({ message: "account?" }));
  }));
  // Stands in for a loopback callback that wins while the paste prompt is open.
  pi.registerProvider("rpc-guard-callback", config(async callbacks => {
    callbacks.onAuth({ url: "https://example.invalid/authorize" });
    const settled = new AbortController();
    const pasted = callbacks.onPrompt({ message: "paste", signal: settled.signal });
    await Bun.sleep(50);
    settled.abort();
    await pasted;
    return credential("c");
  }));
}
`;

describe("RPC login existing-credential guard", () => {
	it("refuses a duplicate with its row, reports added rows, and cancels a superseded paste prompt", async () => {
		await using temp = await TempDir.create("@rpc-login-existing-");
		const keysPath = temp.join("discovery-keys.txt");
		const extensionPath = temp.join("guard.mjs");
		await Bun.write(extensionPath, extensionSource(keysPath));
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "..", "src", "cli.ts"),
				"--trusted-extension",
				extensionPath,
				"--mode",
				"rpc",
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet-4-5",
			],
			{
				cwd: temp.path(),
				env: {
					PATH: Bun.env.PATH,
					HOME: temp.join("home"),
					PI_CODING_AGENT_DIR: temp.join("agent"),
					XDG_CONFIG_HOME: temp.join("config"),
					XDG_DATA_HOME: temp.join("data"),
					XDG_CACHE_HOME: temp.join("cache"),
					CI: "true",
					PI_NO_TITLE: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 25_000,
			},
		);
		const stdout = new Response(child.stdout).body;
		if (!stdout) throw new Error("RPC login fixture did not expose stdout");
		const stderr = new Response(child.stderr).text();
		const send = async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		};
		const discoveryKeys = () => {
			try {
				return fs.readFileSync(keysPath, "utf8").split("\n").filter(Boolean);
			} catch {
				return [];
			}
		};

		// Each login answers its input with the account to sign in as.
		const steps = [
			{ id: "plain-a", providerId: "rpc-guard", account: "a" },
			{ id: "refuse-a", providerId: "rpc-guard", account: "a", existing: "refuse" },
			{ id: "refuse-b", providerId: "rpc-guard", account: "b", existing: "refuse" },
			{ id: "callback", providerId: "rpc-guard-callback", existing: "refuse" },
		] as const;
		const responses = new Map<string, Record<string, unknown>>();
		const keysAfter = new Map<string, number>();
		const frames: Record<string, unknown>[] = [];
		let step = 0;
		let keysBefore = 0;

		try {
			const start = async () => {
				const { account: _account, ...command } = steps[step] as (typeof steps)[number] & { account?: string };
				await send({ type: "login", ...command });
			};
			// Startup discovery may record keys too; count only after the first login starts.
			keysBefore = discoveryKeys().length;
			await start();
			for await (const frame of readJsonl<unknown>(stdout)) {
				if (!isRecord(frame)) continue;
				frames.push(frame);
				const current = steps[step] as (typeof steps)[number] & { account?: string };
				if (frame.type === "extension_ui_request" && frame.method === "input" && current.account) {
					await send({ type: "extension_ui_response", id: frame.id, value: current.account });
				} else if (frame.type === "response" && frame.id === current.id) {
					responses.set(current.id, frame);
					keysAfter.set(current.id, discoveryKeys().length);
					step += 1;
					if (step === steps.length) break;
					await start();
				}
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited;
		}
		if (step !== steps.length) throw new Error(`RPC login fixture did not finish: ${await stderr}`);
		await stderr;

		const plainA = responses.get("plain-a");
		expect(plainA).toMatchObject({
			command: "login",
			success: true,
			data: { providerId: "rpc-guard", outcome: "added", rowId: expect.any(Number), email: "a@example.test" },
		});
		const rowA = (plainA?.data as { rowId?: number } | undefined)?.rowId;
		expect(responses.get("refuse-a")).toEqual({
			id: "refuse-a",
			type: "response",
			command: "login",
			success: false,
			error: "credential_exists",
			code: "credential_exists",
			data: { code: "credential_exists", rowId: rowA, email: "a@example.test" },
		});
		expect(responses.get("refuse-b")).toMatchObject({
			success: true,
			data: { outcome: "added", email: "b@example.test" },
		});
		expect((responses.get("refuse-b")?.data as { rowId?: number } | undefined)?.rowId).not.toBe(rowA);
		// Token values never reach the host.
		for (const frame of frames) expect(JSON.stringify(frame)).not.toContain("access-");

		// The unguarded login refreshes discovery as before; a guarded login next to
		// other stored accounts does not, so it cannot hand them to discovery or refresh them.
		expect(keysAfter.get("plain-a")).toBeGreaterThan(keysBefore);
		expect(keysAfter.get("refuse-b")).toBe(keysAfter.get("refuse-a"));

		// The superseded paste prompt is cancelled on the host.
		const pasteRequest = frames.find(frame => frame.method === "input" && frame.title === "paste");
		expect(pasteRequest).toBeDefined();
		expect(frames).toContainEqual(
			expect.objectContaining({ type: "extension_ui_request", method: "cancel", targetId: pasteRequest?.id }),
		);
		expect(responses.get("callback")).toMatchObject({ success: true, data: { outcome: "added" } });
	}, 40_000);
});
