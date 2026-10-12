import { Database } from "bun:sqlite";
import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { completeSimple, type OAuthCredential } from "@oh-my-pi/pi-ai";
import * as claudeUsageModule from "@oh-my-pi/pi-ai/usage/claude";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ManagedAccountRoutingAdapter } from "@oh-my-pi/pi-coding-agent/modes/rpc/account-routing";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { attemptEditAutoRepair } from "@oh-my-pi/pi-coding-agent/edit/auto-repair";
import {
	getCompletionHandle,
	releaseCompletionHandles,
	runEvalCompletion,
} from "@oh-my-pi/pi-coding-agent/eval/completion-bridge";
import { runEvalWait } from "@oh-my-pi/pi-coding-agent/eval/handle-bridge";
import { createSkillDescriptionCompressor } from "@oh-my-pi/pi-coding-agent/extensibility/skill-descriptions";
import { resolveJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { getMemoryRoot, startMemoryStartupTask } from "@oh-my-pi/pi-coding-agent/memories";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SpeechEnhancer } from "@oh-my-pi/pi-coding-agent/tts/speech-enhancer";
import { resolvePrimaryModel } from "@oh-my-pi/pi-coding-agent/commit/model-selection";
import { describeAttachedImagesForTextModel } from "@oh-my-pi/pi-coding-agent/utils/image-vision-fallback";
import { generateCommitMessage } from "@oh-my-pi/pi-coding-agent/utils/commit-message-generator";
import { askImageQuestion } from "@oh-my-pi/pi-coding-agent/utils/image-question";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Every built-in auxiliary caller that can reach Claude, run against a host-managed registry.
 *
 * What a regression looks like to the host: a caller still asks the registry for a raw bearer
 * (`getApiKey*` answers nothing for managed Claude), so the auxiliary feature silently does nothing,
 * or an unlabeled request is attributed to the main agent turn. Each case below drives the real caller
 * through the real Anthropic transport. The only stubs are the global `fetch` (synthetic endpoint) and
 * a synthetic host answering `admit.request` frames; the file is meant to run with outbound network
 * denied.
 */

const SSE_REPLY = (text: string): string =>
	[
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "claude",
					content: [],
					stop_reason: null,
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			},
		],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 1 },
			},
		],
		["message_stop", { type: "message_stop" }],
	]
		.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
		.join("");

function oauth(suffix: string): OAuthCredential {
	return {
		type: "oauth",
		access: `sk-ant-oat01-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

/** A request that answers its callback with one canned SSE reply once the body is written. */
class ReplyRequest extends http.ClientRequest {
	readonly #callback: (message: http.IncomingMessage) => void;
	readonly #reply: string;
	constructor(callback: (message: http.IncomingMessage) => void, reply: string) {
		super({ path: "/", createConnection: () => new net.Socket() });
		this.#callback = callback;
		this.#reply = reply;
	}

	override end(): this {
		const message = new http.IncomingMessage(new net.Socket());
		message.statusCode = 200;
		message.statusMessage = "OK";
		message.headers = { "content-type": "text/event-stream" };
		message.rawHeaders = ["content-type", "text/event-stream"];
		message.push(this.#reply);
		message.push(null);
		queueMicrotask(() => this.#callback(message));
		return this;
	}
}

interface Admission {
	purpose: string;
	sessionId: string;
	account: string;
}

class Harness {
	readonly tempDir = TempDir.createSync("@pi-managed-aux-");
	// Fresh disabled billing evidence (`spend.enabled: false`) from a synthetic usage endpoint admits the row.
	readonly authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
		usageFetch: (async () =>
			new Response(JSON.stringify({ five_hour: { utilization: 10 }, spend: { enabled: false } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch,
		usageProviderResolver: provider => (provider === "anthropic" ? claudeUsageModule.claudeUsageProvider : undefined),
	});
	readonly registry = new ModelRegistry(this.authStorage, this.tempDir.join("models.yml"));
	readonly adapter = new ManagedAccountRoutingAdapter("model", { completeCoverage: true });
	readonly settings = Settings.isolated({
		"async.enabled": false,
		"compaction.enabled": false,
		"edit.autoRepair.enabled": true,
	});
	readonly model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	/** Account the synthetic host admits next; flipping it models a manual switch between calls. */
	serving: "a" | "b" = "a";
	readonly admissions: Admission[] = [];
	/** Bearer each outbound provider request carried, in order. */
	readonly bearers: string[] = [];
	readonly rawGetters = [
		vi.spyOn(this.registry, "getApiKey"),
		vi.spyOn(this.registry, "getApiKeyForProvider"),
		vi.spyOn(this.registry, "getApiKeyWithCredentialForProvider"),
		vi.spyOn(this.registry, "getApiKeyAndHeaders"),
	];
	/** Text of the n-th provider reply of the current run; the last entry repeats. */
	replies: string[] = ["Synthetic reply"];
	#requestsInRun = 0;
	nextReply(): string {
		return this.replies[Math.min(this.#requestsInRun++, this.replies.length - 1)];
	}

	startRun(): void {
		this.#requestsInRun = 0;
	}

	readonly frames: Array<{ type: string }> = [];
	/** While true the synthetic host never answers an admit request (a paused admission). */
	holdAdmissions = false;

	configureHost(): void {
		this.adapter.configure({
			type: "account.routing.configure",
			version: 1,
			hostEpoch: "epoch-1",
			runtimeInstanceId: "rt-1",
			scope: "host-owned",
			provider: "anthropic",
			includedOnly: true,
		});
	}

	async setup(options: { configure?: boolean } = {}): Promise<this> {
		await this.authStorage.credentials.set("anthropic", [oauth("a"), oauth("b")]);
		const accounts = this.authStorage.credentials.routingIdentities({ provider: "anthropic" }).accounts;
		const refOf = (accountId: string) => accounts.find(account => account.accountId === accountId)!.ref;
		this.settings.setModelRole("smol", `${this.model.provider}/${this.model.id}`);
		this.settings.setModelRole("default", `${this.model.provider}/${this.model.id}`);
		this.registry.useManagedRouting(this.adapter);
		this.adapter.attachSink(frame => {
			this.frames.push(frame);
			if (frame.type !== "account.routing.admit.request" || this.holdAdmissions) return;
			const account = this.serving;
			this.admissions.push({ purpose: frame.purpose, sessionId: frame.sessionId, account });
			queueMicrotask(() =>
				this.adapter.handleControlFrame({
					type: "account.routing.admit.response",
					id: frame.id,
					hostEpoch: frame.hostEpoch,
					runtimeInstanceId: frame.runtimeInstanceId,
					decision: {
						kind: "admit",
						admissionId: `adm-${this.admissions.length}`,
						accountRef: refOf(`account-${account}`),
						selectionGeneration: 1,
						policyRevision: 1,
					},
				}),
			);
		});
		if (options.configure !== false) this.configureHost();
		// Anthropic requests leave through the Cowork transport (`node:https`), not `fetch`; this is the
		// outermost seam, so the real provider code, headers and retry path all run.
		const harness = this;
		vi.spyOn(https, "request").mockImplementation(((
			options: https.RequestOptions,
			callback: (message: http.IncomingMessage) => void,
		) => {
			if (options.hostname !== "api.anthropic.com")
				throw new Error(`unexpected outbound request: ${options.hostname}`);
			const headers = options.headers as Record<string, string>;
			const authorization = Object.entries(headers).find(([name]) => name.toLowerCase() === "authorization")?.[1];
			harness.bearers.push((authorization ?? "").replace("Bearer ", ""));
			return new ReplyRequest(callback, SSE_REPLY(harness.nextReply()));
		}) as unknown as typeof https.request);
		return this;
	}

	/** Raw bearer getters never served a Claude request. */
	expectNoRawClaudeAccess(): void {
		for (const spy of this.rawGetters) {
			const claudeCalls = spy.mock.calls.filter(call => {
				const [target] = call as unknown[];
				return typeof target === "string"
					? target === "anthropic"
					: (target as { provider?: string })?.provider === "anthropic";
			});
			expect(claudeCalls).toEqual([]);
		}
	}

	dispose(): void {
		this.adapter.dispose?.();
		this.authStorage.close();
		this.tempDir.removeSync();
	}
}

const FILE_BROKEN = "function f() {\n\treturn computeNext(1;\n}\n";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function toolSession(h: Harness, extra: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: h.tempDir.path(),
		settings: h.settings,
		modelRegistry: h.registry,
		getSessionId: () => "tool-session",
		getActiveModelString: () => `${h.model.provider}/${h.model.id}`,
		...extra,
	} as unknown as ToolSession;
}

interface AuxiliaryCase {
	name: string;
	/** Host-visible purpose label of every provider request the caller makes. */
	purpose: string;
	/** Provider requests one run makes. */
	requests: number;
	replies: string[];
	/** Runs the real caller once and returns whatever the caller produced, for a liveness check. */
	run(h: Harness): Promise<unknown>;
	expectResult(result: unknown): void;
}

const CASES: AuxiliaryCase[] = [
	{
		name: "title",
		purpose: "title",
		requests: 1,
		replies: ["<title>Payment webhook retries</title>"],
		run: h =>
			generateSessionTitle("Fix the flaky payment webhook retry", h.registry, h.settings, "title-session", h.model),
		expectResult: result => expect(result).toBeTruthy(),
	},
	{
		name: "commit message",
		purpose: "other_auxiliary",
		requests: 1,
		replies: ["fix: retry the payment webhook"],
		run: h =>
			generateCommitMessage(
				"diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
				h.registry,
				h.settings,
				"commit-session",
			),
		expectResult: result => expect(result).toBeTruthy(),
	},
	{
		name: "commit primary model selection",
		purpose: "other_auxiliary",
		requests: 1,
		replies: ["ok"],
		run: async h => {
			const resolved = await resolvePrimaryModel(undefined, h.settings, h.registry);
			// The resolver is minted here and used later by the commit agent: drive it once.
			return completeSimple(
				resolved.model,
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
				{ apiKey: resolved.apiKey, sessionId: "commit-session" },
			);
		},
		expectResult: result => expect((result as { stopReason: string }).stopReason).toBe("stop"),
	},
	{
		name: "speech enhancement",
		purpose: "other_auxiliary",
		requests: 1,
		replies: ["Spoken version of the block."],
		run: h =>
			new SpeechEnhancer({ settings: h.settings, registry: h.registry, sessionId: "tts-session" }).rewrite(
				"Some **markdown** block",
			),
		expectResult: result => expect(result).toBeTruthy(),
	},
	{
		name: "skill description compression",
		purpose: "other_auxiliary",
		requests: 1,
		replies: ["Short skill description."],
		run: h =>
			createSkillDescriptionCompressor(h.registry, h.settings, "skill-session")(
				"skill",
				"A long skill description",
				"compress this",
			),
		expectResult: result => expect(result).toBe("Short skill description."),
	},
	{
		name: "image vision fallback",
		purpose: "vision",
		requests: 1,
		replies: ["A red balloon."],
		run: async h => {
			const dir = await fs.mkdtemp(path.join(h.tempDir.path(), "vision-"));
			return describeAttachedImagesForTextModel([{ type: "image", data: PNG, mimeType: "image/png" }], {
				activeModel: { ...h.model, input: ["text"] },
				modelRegistry: h.registry,
				settings: h.settings,
				localProtocolOptions: { getArtifactsDir: () => dir, getSessionId: () => "vision-session" },
				sessionId: "vision-session",
			});
		},
		expectResult: result => expect(JSON.stringify(result)).toContain("A red balloon."),
	},
	{
		name: "image question",
		purpose: "vision",
		requests: 1,
		replies: ["It is a pixel."],
		run: h =>
			askImageQuestion(
				toolSession(h),
				{ model: h.model, selectedPattern: `${h.model.provider}/${h.model.id}` },
				{ resolvedPath: "p.png", mimeType: "image/png", data: PNG, textNote: "", bytes: 1 },
				"What is this?",
				undefined,
			),
		expectResult: result => expect((result as { text: string }).text).toBe("It is a pixel."),
	},
	{
		name: "edit auto-repair",
		purpose: "repair",
		requests: 1,
		replies: ["\treturn computeNext(1);"],
		run: async h => {
			const file = path.join(h.tempDir.path(), "repair.ts");
			await Bun.write(file, FILE_BROKEN);
			return attemptEditAutoRepair({
				session: toolSession(h),
				snapshot: { path: file, prev: "function f() {\n\treturn compute(1);\n}\n", next: FILE_BROKEN },
				writethrough: async (_dst, content) => ({ finalContent: content }),
			});
		},
		expectResult: result => expect(result).toMatchObject({ attempts: 1 }),
	},
	{
		name: "eval completion",
		purpose: "eval",
		requests: 1,
		replies: ["eval answer"],
		run: async h => {
			const options = { session: toolSession(h) };
			const handle = await runEvalCompletion({ prompt: "q", model: "smol" }, options);
			await runEvalWait({ items: [{ kind: "completion", id: handle.id }] }, options);
			const entry = getCompletionHandle(handle.id);
			releaseCompletionHandles("Main");
			return entry?.result;
		},
		expectResult: result => expect(result).toMatchObject({ text: "eval answer" }),
	},
	{
		name: "judgment",
		purpose: "judgment",
		requests: 1,
		replies: ["yes"],
		run: h =>
			resolveJudge({
				settings: h.settings,
				registry: h.registry,
				sessionModel: h.model,
				sessionId: "judge-session",
				purpose: "test",
			}).judge({
				state: "The build is green.",
				questions: { ok: { type: "choice", instructions: "Is it healthy?", criteria: { yes: null, no: null } } },
			}),
		expectResult: result => expect((result as { answers: { ok: { choice: string } } }).answers.ok.choice).toBe("yes"),
	},
	{
		name: "mnemopi memory completion",
		purpose: "memory",
		requests: 1,
		replies: ["extracted fact"],
		run: async h => {
			const settings = Settings.isolated({
				"memory.backend": "mnemopi",
				"mnemopi.noEmbeddings": true,
				"mnemopi.llmMode": "smol",
			});
			settings.setModelRole("smol", `${h.model.provider}/${h.model.id}`);
			const agentDir = await fs.mkdtemp(path.join(h.tempDir.path(), "mnemopi-"));
			const session = {
				sessionId: "mnemopi-session",
				settings,
				modelRegistry: h.registry,
				sessionManager: {
					getEntries: () => [],
					getBranch: () => [],
					appendCustomEntry: () => {},
					getCwd: () => agentDir,
				},
				emitNotice: () => {},
				getHindsightSessionState: () => undefined,
				getXdevToolEntries: () => [],
				subscribe: () => () => {},
			} as never;
			await mnemopiBackend.start({ session, settings, modelRegistry: h.registry, agentDir, taskDepth: 0 });
			const state = getMnemopiSessionState(session);
			try {
				const llm = state?.config.providerOptions.llm;
				if (typeof llm !== "function") throw new Error("Expected the managed memory completion function");
				return await llm("Extract durable facts.");
			} finally {
				await state?.dispose({ consolidate: false });
			}
		},
		expectResult: result => expect(result).toBe("extracted fact"),
	},
	{
		name: "memory consolidation",
		purpose: "memory",
		requests: 2,
		replies: [
			JSON.stringify({ rollout_summary: "Rollout summary", rollout_slug: "thread-a", raw_memory: "Raw memory" }),
			JSON.stringify({ memory_md: "# Memory", memory_summary: "Summary", skills: [] }),
		],
		run: async h => {
			const agentDir = await fs.mkdtemp(path.join(h.tempDir.path(), "memory-"));
			const sessionDir = path.join(agentDir, "sessions");
			await fs.mkdir(sessionDir, { recursive: true });
			const sessionFile = path.join(sessionDir, "current.jsonl");
			await Bun.write(sessionFile, `${JSON.stringify({ type: "session", id: "current", cwd: agentDir })}\n`);
			await Bun.write(
				path.join(sessionDir, "thread-a.jsonl"),
				[
					{ type: "session", id: "thread-a", cwd: agentDir },
					{ type: "message", message: { role: "user", content: "summarize this" } },
				]
					.map(row => JSON.stringify(row))
					.join("\n"),
			);
			const settled = Promise.withResolvers<void>();
			const settings = Settings.isolated({
				"memories.enabled": true,
				"memories.minRolloutIdleHours": 0,
				"memories.phase2HeartbeatSeconds": 1,
			});
			settings.setModelRole("default", `${h.model.provider}/${h.model.id}`);
			startMemoryStartupTask({
				session: {
					sessionManager: {
						getSessionFile: () => sessionFile,
						getSessionDir: () => sessionDir,
						getSessionId: () => "current",
						getCwd: () => agentDir,
					},
					settings,
					model: h.model,
					modelRegistry: h.registry,
					refreshBaseSystemPrompt: async () => settled.resolve(),
				} as never,
				settings,
				modelRegistry: h.registry,
				agentDir,
				taskDepth: 0,
			});
			await settled.promise;
			return Bun.file(path.join(getMemoryRoot(agentDir, agentDir), "MEMORY.md")).text();
		},
		expectResult: result => expect(result).toContain("# Memory"),
	},
];

describe("managed Claude auxiliary callers", () => {
	let h: Harness;
	beforeEach(async () => {
		h = await new Harness().setup();
	});
	afterEach(() => {
		h.dispose();
		vi.restoreAllMocks();
	});

	for (const testCase of CASES) {
		it(`${testCase.name} dispatches through host admission, labeled and without a raw bearer`, async () => {
			h.replies = testCase.replies;
			h.startRun();
			testCase.expectResult(await testCase.run(h));
			expect(h.admissions).toHaveLength(testCase.requests);
			expect(
				h.admissions.every(admission => admission.account === "a" && admission.purpose === testCase.purpose),
			).toBe(true);
			expect(h.bearers).toEqual(Array(testCase.requests).fill("sk-ant-oat01-a"));
			h.expectNoRawClaudeAccess();

			// A manual switch between two calls moves the next request, not the finished one.
			h.serving = "b";
			h.startRun();
			testCase.expectResult(await testCase.run(h));
			expect(h.admissions.slice(testCase.requests).every(admission => admission.account === "b")).toBe(true);
			expect(h.bearers.slice(testCase.requests)).toEqual(Array(testCase.requests).fill("sk-ant-oat01-b"));
			h.expectNoRawClaudeAccess();
		});
	}
});

describe("managed Claude auxiliary lifecycle", () => {
	let h: Harness;
	afterEach(() => {
		h.dispose();
		vi.restoreAllMocks();
	});

	it("holds an auxiliary request until the host configures, then admits it", async () => {
		h = await new Harness().setup({ configure: false });
		h.replies = ["<title>Webhook retries</title>"];
		const pending = generateSessionTitle(
			"Fix the flaky payment webhook retry",
			h.registry,
			h.settings,
			"title-session",
			h.model,
		);
		await Bun.sleep(25);
		expect(h.frames).toEqual([]);
		expect(h.bearers).toEqual([]);

		h.configureHost();
		expect(await pending).toBeTruthy();
		expect(h.admissions).toEqual([expect.objectContaining({ purpose: "title", account: "a" })]);
	});

	it("releases a paused auxiliary admission on cancel without dispatching", async () => {
		h = await new Harness().setup();
		h.holdAdmissions = true;
		const cancel = new AbortController();
		const pending = generateSessionTitle(
			"Fix the flaky payment webhook retry",
			h.registry,
			h.settings,
			"title-session",
			h.model,
			undefined,
			undefined,
			cancel.signal,
		);
		await Bun.sleep(25);
		expect(h.frames.map(frame => frame.type)).toContain("account.routing.admit.request");
		cancel.abort();
		expect(await pending).toBeNull();
		expect(h.bearers).toEqual([]);
		expect(h.frames.map(frame => frame.type)).toContain("account.routing.cancel");
		// Nothing is left pending: the next call is admitted normally.
		h.holdAdmissions = false;
		h.replies = ["<title>Webhook retries</title>"];
		expect(
			await generateSessionTitle(
				"Fix the flaky payment webhook retry",
				h.registry,
				h.settings,
				"title-session",
				h.model,
			),
		).toBeTruthy();
	});

	it("refuses the raw-credential extension facade by name instead of reporting a missing key", async () => {
		h = await new Harness().setup();
		const refusal = await h.registry.getApiKeyAndHeaders(h.model);
		expect(refusal).toEqual({ ok: false, error: expect.stringContaining("host-managed account routing") });
		expect(h.bearers).toEqual([]);
	});
});
