import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ApiKeyResolution, ApiKeyResolveContext } from "@oh-my-pi/pi-ai";
import {
	type AccountRef,
	AuthStorage,
	type ManagedAdmissionGrant,
	type ManagedAttemptOutcome,
	type ManagedCallContext,
	type ManagedRoutingDriver,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import { type ApiKeyResolver, ManagedDispatchRefusedError, withAuth } from "@oh-my-pi/pi-ai/auth-retry";
import * as claudeUsage from "@oh-my-pi/pi-ai/usage/claude";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { registerCustomApi, resolveApiKeyOnce, seedApiKeyResolver, unregisterCustomApis } from "@oh-my-pi/pi-ai";
import { OAuthError, ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { classify } from "@oh-my-pi/pi-ai/error/flags";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

const SOURCE_ID = "stream-auth-retry-test";
const API = "stream-auth-retry-test" as Api;

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(content: string[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: content.map(text => ({ type: "text" as const, text })),
		api: API,
		provider: "test-provider",
		model: "test-model",
		timestamp: 1,
		stopReason: "stop",
		usage: usage(),
	};
}

function assistantError(errorMessage: string, errorStatus?: number, errorId?: number): AssistantMessage {
	return { ...assistant(), stopReason: "error", errorMessage, errorStatus, errorId };
}

function authError(): Error & { status: number } {
	return Object.assign(new Error("401 authentication_error"), { status: 401 });
}

function usageLimitError(): Error & { status: number } {
	return Object.assign(new Error("You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min."), {
		status: 429,
	});
}

const GOOGLE_CAPACITY_EXHAUSTED_MESSAGE = `Cloud Code Assist API error (429): ${JSON.stringify({
	error: {
		code: 429,
		message: "You have exhausted your capacity on this model. Resets in 0s.",
		status: "RESOURCE_EXHAUSTED",
		details: [
			{
				"@type": "type.googleapis.com/google.rpc.ErrorInfo",
				reason: "RATE_LIMIT_EXCEEDED",
				domain: "cloudcode-pa.googleapis.com",
				metadata: {
					model: "gemini-3.7-flash-medium",
					quotaResetDelay: "835.150299ms",
				},
			},
			{
				"@type": "type.googleapis.com/google.rpc.RetryInfo",
				retryDelay: "0.835150299s",
			},
		],
	},
})}`;

function model(): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: API,
		provider: "test-provider",
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<Api>;
}

const context: Context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

/** Records the static key each inner attempt actually received. */
function pushKey(keys: unknown[], options?: SimpleStreamOptions): void {
	keys.push(options?.apiKey);
}

function ok(stream: AssistantMessageEventStream): void {
	const message = assistant(["ok"]);
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
}

describe("streamSimple resolver auth retry", () => {
	afterEach(() => {
		unregisterCustomApis(SOURCE_ID);
	});

	it("retries with a refreshed key when a 401 is thrown before the first event", async () => {
		const keys: unknown[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => (keys.length === 1 ? stream.fail(authError()) : ok(stream)));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				contexts.push(ctx);
				return ctx.error === undefined ? "old-key" : ctx.lastChance ? "switch-key" : "refresh-key";
			},
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		// Initial resolve, then step (b) refresh-same — the switch step is never reached.
		expect(keys).toEqual(["old-key", "refresh-key"]);
		expect(keys.every(key => typeof key === "string")).toBe(true);
		expect(contexts.map(ctx => ({ lastChance: ctx.lastChance, hasError: ctx.error !== undefined }))).toEqual([
			{ lastChance: false, hasError: false },
			{ lastChance: false, hasError: true },
		]);
		expect(contexts[1]).toBeDefined();
		expect((contexts[1]!.error as { status?: number }).status).toBe(401);
	});

	it("stamps the serving sibling after a 401 rotates away from the signed-in credential", async () => {
		const attempted: Array<{ key: string | undefined; credentialId: number | undefined }> = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				attempted.push({
					key: typeof options?.apiKey === "string" ? options.apiKey : undefined,
					credentialId: options?.credentialId,
				});
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => (options?.apiKey === "first" ? stream.fail(authError()) : ok(stream)));
				return stream;
			},
			SOURCE_ID,
		);
		const resolver = (ctx: ApiKeyResolveContext) =>
			ctx.lastChance ? { apiKey: "sibling", credentialId: 2 } : { apiKey: "first", credentialId: 1 };
		let preflight: ApiKeyResolution;
		await resolveApiKeyOnce(resolver, undefined, resolved => {
			preflight = resolved;
		});
		const stream = streamSimple(model(), context, { apiKey: seedApiKeyResolver(preflight, resolver) });
		let doneCredentialId: number | undefined;
		for await (const event of stream) {
			if (event.type === "done") doneCredentialId = event.message.credentialId;
		}
		expect(attempted).toEqual([
			{ key: "first", credentialId: 1 },
			{ key: "sibling", credentialId: 2 },
		]);
		expect(doneCredentialId).toBe(2);
		expect((await stream.result()).credentialId).toBe(2);
	});

	it("replays exactly once after a provider requests token refresh, then succeeds", async () => {
		const keys: unknown[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		let providerCalls = 0;
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				providerCalls += 1;
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() =>
					providerCalls === 1
						? stream.fail(
								new OAuthError("OAuth token expired before request", {
									kind: "token-refresh",
									provider: "google-antigravity",
								}),
							)
						: ok(stream),
				);
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				contexts.push(ctx);
				return ctx.error === undefined ? "expired-key" : "fresh-key";
			},
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(providerCalls).toBe(2);
		expect(keys).toEqual(["expired-key", "fresh-key"]);
		expect(contexts).toHaveLength(2);
		expect(contexts[1]?.error).toBeInstanceOf(OAuthError);
	});

	it("propagates a second token-refresh request without rotating to a third key", async () => {
		const keys: unknown[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		const firstError = new OAuthError("First token expired before request", {
			kind: "token-refresh",
			provider: "google-antigravity",
		});
		const secondError = new OAuthError("Refreshed token also expired before request", {
			kind: "token-refresh",
			provider: "google-antigravity",
		});
		let providerCalls = 0;
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				providerCalls += 1;
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.fail(providerCalls === 1 ? firstError : secondError));
				return stream;
			},
			SOURCE_ID,
		);

		const offeredKeys = ["expired-key", "fresh-key", "third-key"];
		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				const key = offeredKeys[contexts.length];
				contexts.push(ctx);
				return key;
			},
		});
		await expect(
			(async () => {
				for await (const _event of stream) {
					// drain
				}
			})(),
		).rejects.toBe(secondError);

		expect(providerCalls).toBe(2);
		expect(keys).toEqual(["expired-key", "fresh-key"]);
		expect(contexts).toHaveLength(2);
	});

	it("propagates typed OAuth configuration errors without resolving a retry key", async () => {
		const keys: unknown[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		const configurationError = new OAuthError("OAuth provider is misconfigured", {
			kind: "configuration",
			provider: "google-antigravity",
		});
		let providerCalls = 0;
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				providerCalls += 1;
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.fail(configurationError));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				contexts.push(ctx);
				return ctx.error === undefined ? "initial-key" : "unexpected-retry-key";
			},
		});
		await expect(
			(async () => {
				for await (const _event of stream) {
					// drain
				}
			})(),
		).rejects.toBe(configurationError);

		expect(providerCalls).toBe(1);
		expect(keys).toEqual(["initial-key"]);
		expect(contexts).toHaveLength(1);
	});

	it("surfaces a 403 concurrency cap for transient backoff without rotating credentials", async () => {
		const keys: unknown[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		const concurrencyCap = Object.assign(new Error("concurrent requests limit reached"), { status: 403 });
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.fail(concurrencyCap));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				contexts.push(ctx);
				return ctx.error === undefined ? "old-key" : ctx.lastChance ? "sibling-key" : "refresh-key";
			},
		});
		await expect(
			(async () => {
				for await (const _event of stream) {
					// drain
				}
			})(),
		).rejects.toBe(concurrencyCap);

		expect(keys).toEqual(["old-key"]);
		expect(contexts.map(ctx => ({ lastChance: ctx.lastChance, hasError: ctx.error !== undefined }))).toEqual([
			{ lastChance: false, hasError: false },
		]);
	});

	it("buffers the start event and retries on a 401 error event before content", async () => {
		const keys: unknown[] = [];
		const eventTypes: string[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.push({ type: "start", partial: assistant() });
						stream.push({
							type: "error",
							reason: "error",
							error: assistantError(
								'Error: 401\n{"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
							),
						});
						return;
					}
					ok(stream);
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => (ctx.error === undefined ? "old-key" : "new-key"),
		});
		for await (const event of stream) {
			eventTypes.push(event.type);
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "new-key"]);
		// The failed attempt's buffered start must not leak — the user sees a
		// single start from the successful attempt, then its healed content.
		expect(eventTypes).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
	});

	it("retries on a 401 carried only via errorStatus", async () => {
		const keys: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.push({ type: "start", partial: assistant() });
						stream.push({
							type: "error",
							reason: "error",
							error: assistantError(
								'{"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
								401,
							),
						});
						return;
					}
					ok(stream);
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => (ctx.error === undefined ? "old-key" : "new-key"),
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "new-key"]);
	});

	it("retries when Codex reports an invalidated OAuth token without an HTTP status", async () => {
		const keys: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.push({ type: "start", partial: assistant() });
						stream.push({
							type: "error",
							reason: "error",
							error: assistantError("Encountered invalidated oauth token for user, failing request"),
						});
						return;
					}
					ok(stream);
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => (ctx.error === undefined ? "invalidated-key" : "healthy-key"),
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["invalidated-key", "healthy-key"]);
	});

	it("does not retry after replay-unsafe content has been emitted", async () => {
		let retryResolves = 0;
		const failure = authError();
		registerCustomApi(
			API,
			() => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: assistant() });
					stream.push({ type: "text_start", contentIndex: 0, partial: assistant([""]) });
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: "partial",
						partial: assistant(["partial"]),
					});
					stream.fail(failure);
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				if (ctx.error !== undefined) retryResolves += 1;
				return ctx.error === undefined ? "old-key" : "new-key";
			},
		});

		let caught: unknown;
		try {
			for await (const _event of stream) {
				// drain
			}
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(failure);
		// The resolver is never asked for a retry key once a replay-unsafe event shipped.
		expect(retryResolves).toBe(0);
	});

	it("escalates refresh-same then switch in order (2-retry ordering)", async () => {
		const keys: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => (options?.apiKey === "switch-key" ? ok(stream) : stream.fail(authError())));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => (ctx.error === undefined ? "old-key" : ctx.lastChance ? "switch-key" : "refresh-key"),
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "refresh-key", "switch-key"]);
	});

	it("skips the refresh-same step when the resolver returns an unchanged key", async () => {
		const keys: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => (options?.apiKey === "switch-key" ? ok(stream) : stream.fail(authError())));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			// refresh-same yields the same failing key → that attempt is skipped.
			apiKey: async ctx => (ctx.error === undefined ? "old-key" : ctx.lastChance ? "switch-key" : "old-key"),
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "switch-key"]);
	});

	it("retries a thrown usage-limit error and passes the cause to the resolver", async () => {
		const keys: unknown[] = [];
		const errors: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => (keys.length === 1 ? stream.fail(usageLimitError()) : ok(stream)));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				if (ctx.error !== undefined) errors.push(ctx.error);
				return ctx.error === undefined ? "old-key" : "new-key";
			},
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "new-key"]);
		expect(errors).toHaveLength(1);
		// The cause carries the original 429 so the resolver can branch usage-limit vs 401.
		expect((errors[0] as { status?: number }).status).toBe(429);
		expect((errors[0] as Error).message).toMatch(/usage limit/i);
	});

	it("retries a usage-limit error event before content", async () => {
		const keys: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.push({ type: "start", partial: assistant() });
						stream.push({
							type: "error",
							reason: "error",
							error: assistantError("You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min."),
						});
						return;
					}
					ok(stream);
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => (ctx.error === undefined ? "old-key" : "new-key"),
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "new-key"]);
	});

	it("rotates on a machine-code-only usage error event before content", async () => {
		const keys: unknown[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		const errorId = classify(new ProviderHttpError("Generic provider failure", 429, { code: "insufficient_quota" }));
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (keys.length === 1) {
						stream.push({ type: "start", partial: assistant() });
						stream.push({
							type: "error",
							reason: "error",
							error: assistantError("Generic provider failure", 429, errorId),
						});
						return;
					}
					ok(stream);
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				contexts.push(ctx);
				return ctx.error === undefined ? "old-key" : "new-key";
			},
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "new-key"]);
		expect(contexts.map(ctx => ctx.lastChance)).toEqual([false, true]);
	});

	it("rotates through every distinct sibling while usage failures remain replay-safe", async () => {
		const keys: unknown[] = [];
		const eventTypes: string[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		const pool = ["credential-A", "credential-B", "credential-C", "credential-D"];
		let nextSibling = 0;
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (options?.apiKey === "credential-D") {
						ok(stream);
						return;
					}
					stream.push({ type: "start", partial: assistant() });
					stream.push({
						type: "error",
						reason: "error",
						error: assistantError("You have hit your ChatGPT usage limit (pro plan). Try again later.", 429),
					});
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				contexts.push(ctx);
				return ctx.error === undefined ? pool[0] : pool[++nextSibling];
			},
		});
		for await (const event of stream) {
			eventTypes.push(event.type);
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(pool);
		expect(contexts.map(ctx => ctx.lastChance)).toEqual([false, true, true, true]);
		expect(eventTypes).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
	});

	it("rotates through every distinct sibling on Codex cyber-policy denials", async () => {
		const keys: unknown[] = [];
		const eventTypes: string[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		const pool = ["credential-A", "credential-B", "credential-C", "credential-D"];
		const errorMessage =
			"Codex error event: This content was flagged for possible cybersecurity risk. Join Trusted Access for Cyber. (code=cyber_policy)";
		const errorId = classify(new Error(errorMessage), "openai-codex-responses");
		let nextSibling = 0;
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (options?.apiKey === "credential-D") {
						ok(stream);
						return;
					}
					stream.push({ type: "start", partial: assistant() });
					stream.push({
						type: "error",
						reason: "error",
						error: assistantError(errorMessage, undefined, errorId),
					});
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				contexts.push(ctx);
				return ctx.error === undefined ? pool[0] : pool[++nextSibling];
			},
		});
		for await (const event of stream) {
			eventTypes.push(event.type);
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(pool);
		expect(contexts.map(ctx => ctx.lastChance)).toEqual([false, true, true, true]);
		expect(eventTypes).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
	});

	it("stops replay-safe usage rotation when the resolver cycles to an attempted credential", async () => {
		const keys: unknown[] = [];
		const resolved = ["credential-A", "credential-B", "credential-A"];
		let resolveIndex = 0;
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: assistant() });
					stream.push({
						type: "error",
						reason: "error",
						error: assistantError("You have hit your ChatGPT usage limit (pro plan). Try again later.", 429),
					});
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async () => resolved[resolveIndex++],
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).stopReason).toBe("error");
		expect(keys).toEqual(["credential-A", "credential-B"]);
	});

	it("rotates before emitting content for quota and billing-cap payloads", async () => {
		const payloads: Array<{ message: string; status?: number }> = [
			{ message: "429", status: 429 },
			{ message: '{"error":{"code":"insufficient_quota","message":"quota exhausted"}}' },
			{ message: '{"error":{"code":"usage_limit_exceeded","message":"usage limit exceeded"}}' },
			{ message: '{"error":{"code":"usage_limit_reached","message":"usage limit reached"}}' },
			{ message: "Upstream request failed: Insufficient account funds", status: 402 },
		];
		let activePayload = payloads[0]!;
		let keys: unknown[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (options?.apiKey === "credential-B") {
						ok(stream);
						return;
					}
					stream.push({ type: "start", partial: assistant() });
					stream.push({
						type: "error",
						reason: "error",
						error: assistantError(activePayload.message, activePayload.status),
					});
				});
				return stream;
			},
			SOURCE_ID,
		);

		for (const payload of payloads) {
			activePayload = payload;
			keys = [];
			const eventTypes: string[] = [];
			const retryContexts: ApiKeyResolveContext[] = [];
			const stream = streamSimple(model(), context, {
				apiKey: async ctx => {
					if (ctx.error !== undefined) retryContexts.push(ctx);
					return ctx.error === undefined ? "credential-A" : ctx.lastChance ? "credential-B" : "credential-A";
				},
			});
			for await (const event of stream) {
				eventTypes.push(event.type);
			}

			expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
			expect(keys).toEqual(["credential-A", "credential-B"]);
			expect(eventTypes).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
			expect(retryContexts.map(ctx => ctx.lastChance)).toEqual([true]);
		}
	});

	it("does not rotate or refresh on informative transient 429 bodies", async () => {
		const transient429Bodies = [
			"Cloud Code Assist API error (429): Too many requests",
			"Please retry in 5s",
			"Service overloaded 529",
		];
		let active = transient429Bodies[0]!;
		const keys: unknown[] = [];
		const retryResolves: ApiKeyResolveContext[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: assistant() });
					stream.push({
						type: "error",
						reason: "error",
						error: assistantError(active, 429),
					});
				});
				return stream;
			},
			SOURCE_ID,
		);

		for (const body of transient429Bodies) {
			active = body;
			keys.length = 0;
			retryResolves.length = 0;
			const eventTypes: string[] = [];
			const stream = streamSimple(model(), context, {
				apiKey: async ctx => {
					if (ctx.error !== undefined) retryResolves.push(ctx);
					return ctx.error === undefined ? "credential-A" : "credential-B";
				},
			});

			for await (const event of stream) {
				eventTypes.push(event.type);
			}
			const result = await stream.result();

			// The provider's own retry/backoff layer owns these — the auth
			// retry loop must NOT capture, refresh, or burn a sibling.
			expect(retryResolves).toEqual([]);
			expect(keys).toEqual(["credential-A"]);
			expect(eventTypes).toEqual(["start", "error"]);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain(body);
		}
	});

	it("rotates on short Google account capacity exhaustion before content", async () => {
		const keys: unknown[] = [];
		const retryContexts: ApiKeyResolveContext[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (options?.apiKey === "next-key") {
						ok(stream);
						return;
					}
					stream.push({ type: "start", partial: assistant() });
					stream.push({
						type: "error",
						reason: "error",
						error: assistantError(GOOGLE_CAPACITY_EXHAUSTED_MESSAGE, 429),
					});
				});
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			apiKey: async ctx => {
				if (ctx.error !== undefined) retryContexts.push(ctx);
				return ctx.error === undefined ? "old-key" : ctx.lastChance ? "next-key" : "old-key";
			},
		});
		for await (const _event of stream) {
			// drain
		}

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["old-key", "next-key"]);
		expect(retryContexts.map(ctx => ({ lastChance: ctx.lastChance, hasError: ctx.error !== undefined }))).toEqual([
			{ lastChance: true, hasError: true },
		]);
		const retryError = retryContexts[0]?.error;
		if (!(retryError instanceof Error)) throw new Error("Expected credential retry error");
		expect(retryError.message).toContain("exhausted your capacity");
	});

	it("surfaces the original error when the resolver declines every retry", async () => {
		const keys: unknown[] = [];
		const original = usageLimitError();
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				pushKey(keys, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.fail(original));
				return stream;
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, {
			// Decline all retries: no sibling credential to rotate to.
			apiKey: async ctx => (ctx.error === undefined ? "old-key" : undefined),
		});

		let caught: unknown;
		try {
			for await (const _event of stream) {
				// drain
			}
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(original);
		expect(keys).toEqual(["old-key"]);
	});

	it("fails the stream when the initial resolve yields no key", async () => {
		let attempts = 0;
		registerCustomApi(
			API,
			() => {
				attempts += 1;
				return new AssistantMessageEventStream();
			},
			SOURCE_ID,
		);

		const stream = streamSimple(model(), context, { apiKey: async () => undefined });

		let caught: unknown;
		try {
			for await (const _event of stream) {
				// drain
			}
		} catch (error) {
			caught = error;
		}

		expect((caught as Error).message).toMatch(/No API key for provider/);
		expect(attempts).toBe(0);
	});
});

describe("managed Claude routing through the stream boundary", () => {
	const NOW = 1_800_000_000_000;
	const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
	const ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
	const savedEnv: Record<string, string | undefined> = {};
	const claude = buildModel({
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
	const ctx: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

	let dir = "";
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;
	let clock = NOW;
	let ids: Record<string, number> = {};
	let namespace = "";
	let selected = "a";
	let hostCalls: Array<{ call: ManagedCallContext; previous: ManagedAttemptOutcome | undefined }> = [];
	let started: ManagedAdmissionGrant[] = [];
	let outcomes: Array<{ grant: ManagedAdmissionGrant; outcome: ManagedAttemptOutcome }> = [];
	let requests: Array<{ bearer: string; accountUuid: string | undefined }> = [];
	let messageScript: Array<() => Response | Promise<Response>> = [];
	let generation = 0;
	let attemptSeq = 0;
	let refuseAfterQuota = true;
	let advanceClockAfterResolve = 0;

	const sse = (events: object[]): Response =>
		new Response(
			events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
			{
				status: 200,
				headers: { "content-type": "text/event-stream" },
			},
		);
	const okResponse = (): Response =>
		sse([
			{ type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		]);
	const failure =
		(status: number, headers: Record<string, string> = {}): (() => Response) =>
		() =>
			new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }), {
				status,
				headers: { "content-type": "application/json", ...headers },
			});

	const messagesFetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!url.includes("/v1/messages")) throw new Error(`unexpected request to ${url}`);
		const headers = new Headers(init?.headers);
		const body = JSON.parse(await new Response(init?.body as ConstructorParameters<typeof Response>[0]).text()) as {
			metadata?: { user_id?: string };
		};
		const userId = body.metadata?.user_id
			? (JSON.parse(body.metadata.user_id) as { account_uuid?: string })
			: undefined;
		requests.push({
			bearer: (headers.get("authorization") ?? "").replace(/^Bearer /i, ""),
			accountUuid: userId?.account_uuid,
		});
		const next = messageScript.shift() ?? okResponse;
		return next();
	}) as unknown as typeof fetch;

	const ref = (suffix: string): AccountRef => ({ storeNamespace: namespace, nativeRowId: ids[suffix]! });
	const lifecycle = {
		isConfigured: () => true,
		started: (grant: ManagedAdmissionGrant) => started.push(grant),
		outcome: (grant: ManagedAdmissionGrant, outcome: ManagedAttemptOutcome) => outcomes.push({ grant, outcome }),
	};
	const driver: ManagedRoutingDriver = {
		beginCall: input => ({
			operationId: `op-${++generation}`,
			requestGeneration: generation,
			sessionId: input.sessionId,
			modelId: input.modelId,
			purpose: input.purpose,
			signal: input.signal,
			replayPolicy: input.replayPolicy,
		}),
		acquire: async (call, options) => {
			hostCalls.push({ call, previous: options.previousOutcome });
			if (refuseAfterQuota && options.previousOutcome?.code === "quota_exhausted") {
				throw new ManagedDispatchRefusedError("quota_blocked", 1000);
			}
			return {
				hostEpoch: "epoch",
				runtimeInstanceId: "rt",
				admissionId: `adm-${attemptSeq}`,
				selectionGeneration: 1,
				policyRevision: 1,
				accountRef: ref(selected),
				operationId: call.operationId,
				attemptId: `att-${++attemptSeq}`,
				requestGeneration: call.requestGeneration,
				sessionId: call.sessionId,
				modelId: call.modelId,
				purpose: call.purpose,
			};
		},
		isConfigured: () => true,
	};
	const resolver: ApiKeyResolver = Object.assign(
		async (rctx: ApiKeyResolveContext): Promise<ApiKeyResolution> => {
			const call = rctx.managedCall;
			if (!call) throw new Error("managed resolver requires a call");
			const admission = await driver.acquire(call, { previousOutcome: rctx.previousOutcome });
			const result = await storage.routing.resolveExact({
				accountRef: admission.accountRef,
				modelId: call.modelId,
				baseUrl: "https://api.anthropic.com",
				admission,
				call,
				lifecycle,
				signal: rctx.signal,
			});
			if ("refusal" in result) throw new ManagedDispatchRefusedError(result.code, result.retryAfterMs);
			clock += advanceClockAfterResolve;
			advanceClockAfterResolve = 0;
			return result;
		},
		{ managedRouting: driver },
	);

	beforeEach(async () => {
		for (const key of ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-managed-stream-"));
		store = await SqliteAuthCredentialStore.open(path.join(dir, "agent.db"));
		clock = NOW;
		selected = "a";
		hostCalls = [];
		started = [];
		outcomes = [];
		requests = [];
		messageScript = [];
		generation = 0;
		attemptSeq = 0;
		refuseAfterQuota = true;
		advanceClockAfterResolve = 0;
		const usageFetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url !== USAGE_URL) return new Response("{}", { status: 404 });
			return new Response(JSON.stringify({ five_hour: { utilization: 10 }, spend: { enabled: false } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		storage = new AuthStorage(store, {
			usageFetch,
			routingClock: () => clock,
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.credentials.set(
			"anthropic",
			["a", "b"].map(suffix => ({
				type: "oauth" as const,
				access: `sk-ant-oat01-${suffix}`,
				refresh: `refresh-${suffix}`,
				expires: NOW + 3_600_000,
				accountId: `acc-${suffix}`,
				email: `${suffix}@example.com`,
			})),
		);
		const catalog = storage.credentials.routingIdentities({ provider: "anthropic" });
		if (catalog.source.status !== "supported") throw new Error("expected namespace");
		namespace = catalog.source.storeNamespace;
		ids = Object.fromEntries(
			catalog.accounts.map(account => [account.accountId?.replace("acc-", "") ?? "", account.ref.nativeRowId]),
		);
	});

	afterEach(async () => {
		store.close();
		await fs.rm(dir, { recursive: true, force: true });
		for (const key of ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	const run = async (options: Partial<SimpleStreamOptions> = {}) => {
		const stream = streamSimple(claude, ctx, {
			apiKey: resolver,
			fetch: messagesFetch,
			providerRetryWait: async () => {},
			sessionId: "sess",
			...options,
		} as SimpleStreamOptions);
		let error: unknown;
		let result: AssistantMessage | undefined;
		try {
			for await (const _ of stream) {
				// drain
			}
			result = await stream.result();
		} catch (caught) {
			error = caught;
		}
		return { result, error };
	};

	it("serves the granted row, carries its identity in the request, and settles exactly one success outcome", async () => {
		const { result } = await run();
		expect(result?.stopReason).toBe("stop");
		expect(requests).toEqual([{ bearer: "sk-ant-oat01-a", accountUuid: "acc-a" }]);
		expect(started.map(grant => grant.attemptId)).toEqual(["att-1"]);
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]?.outcome).toMatchObject({ code: "success", dispatch: "dispatched", refusalReason: null });
		expect(outcomes[0]?.outcome.startedAt).not.toBeNull();
	});

	it("gives every provider HTTP retry its own grant and outcome and follows the host to the new account", async () => {
		messageScript = [failure(529), okResponse];
		const first = await run({
			// The host moves to B once it sees the first attempt's outcome.
			sessionId: "sess",
		});
		expect(first.result?.stopReason).toBe("stop");
		expect(hostCalls).toHaveLength(2);
		expect(hostCalls[1]?.previous?.code).toBe("provider_failed");
		expect(requests.map(request => request.bearer)).toEqual(["sk-ant-oat01-a", "sk-ant-oat01-a"]);
		expect(outcomes.map(entry => entry.outcome.code)).toEqual(["provider_failed", "success"]);
		expect(outcomes.map(entry => entry.grant.attemptId)).toEqual(["att-1", "att-2"]);
		expect(new Set(outcomes.map(entry => entry.grant.operationId)).size).toBe(1);
	});

	it("re-binds the bearer and body identity when the host grants a different account for the retry", async () => {
		messageScript = [
			() => {
				selected = "b";
				return failure(529)();
			},
			okResponse,
		];
		const { result } = await run();
		expect(result?.stopReason).toBe("stop");
		expect(requests).toEqual([
			{ bearer: "sk-ant-oat01-a", accountUuid: "acc-a" },
			{ bearer: "sk-ant-oat01-b", accountUuid: "acc-b" },
		]);
		expect(outcomes.map(entry => entry.grant.accountRef.nativeRowId)).toEqual([ids.a, ids.b]);
	});

	it("an empty-completion retry is a new HTTP attempt with its own grant and outcome", async () => {
		const empty = (): Response =>
			sse([
				{ type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 0 } } },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
				{ type: "message_stop" },
			]);
		messageScript = [empty, okResponse];
		const { result } = await run();
		expect(result?.stopReason).toBe("stop");
		expect(requests).toHaveLength(2);
		expect(outcomes).toHaveLength(2);
		expect(new Set(outcomes.map(entry => entry.grant.attemptId)).size).toBe(2);
		expect(new Set(outcomes.map(entry => entry.grant.operationId)).size).toBe(1);
	});

	it("keeps an in-flight A request on A while the next continuation is granted B", async () => {
		const gate = Promise.withResolvers<void>();
		messageScript = [
			async () => {
				await gate.promise;
				return okResponse();
			},
			okResponse,
		];
		const inFlightA = run({ sessionId: "one" });
		await Bun.sleep(50);
		selected = "b";
		const nextB = await run({ sessionId: "two" });
		expect(nextB.result?.stopReason).toBe("stop");
		gate.resolve();
		const settledA = await inFlightA;
		expect(settledA.result?.stopReason).toBe("stop");
		expect(requests.map(request => request.bearer).sort()).toEqual(["sk-ant-oat01-a", "sk-ant-oat01-b"]);
		const byAccount = new Map(outcomes.map(entry => [entry.grant.accountRef.nativeRowId, entry]));
		expect(outcomes).toHaveLength(2);
		expect(byAccount.get(ids.a)?.grant.operationId).not.toBe(byAccount.get(ids.b)?.grant.operationId);
		expect(byAccount.get(ids.a)?.outcome.code).toBe("success");
	});

	it("reads positive exhaustion only from unified utilization>=1 with a future reset and never falls back", async () => {
		const reset = String(Math.floor((Date.now() + 3_600_000) / 1000));
		messageScript = [
			failure(429, {
				"anthropic-ratelimit-unified-5h-utilization": "1",
				"anthropic-ratelimit-unified-5h-reset": reset,
			}),
		];
		const { result, error } = await run();
		expect(requests).toHaveLength(1);
		expect(outcomes[0]?.outcome.code).toBe("quota_exhausted");
		expect(outcomes[0]?.outcome.quotaBlocks).toHaveLength(1);
		// The host refused re-admission: terminal failure, no sibling, no API-key request.
		expect(result?.stopReason === "error" || error !== undefined).toBe(true);
	});

	// Outcome timestamps use the wall clock; only admission uses the injected one.
	const reset = (offsetMs: number): string => String(Math.floor((Date.now() + offsetMs) / 1000));
	const NON_QUOTA_429: Array<[string, Record<string, string>]> = [
		["a bare 429", {}],
		[
			"a below-limit window",
			{
				"anthropic-ratelimit-unified-5h-utilization": "0.4",
				"anthropic-ratelimit-unified-5h-reset": reset(3_600_000),
			},
		],
		[
			"an exhausted window whose reset is past",
			{ "anthropic-ratelimit-unified-5h-utilization": "1", "anthropic-ratelimit-unified-5h-reset": reset(-60_000) },
		],
	];
	for (const [label, headers] of NON_QUOTA_429) {
		it(`${label} never establishes quota`, async () => {
			refuseAfterQuota = false;
			messageScript = Array.from({ length: 40 }, () => failure(429, headers));
			await run();
			expect(outcomes.length).toBeGreaterThan(0);
			for (const entry of outcomes) {
				expect(entry.outcome.code).toBe("rate_limited");
				expect(entry.outcome.quotaBlocks).toEqual([]);
			}
		}, 20_000);
	}

	it("billing expiring between pre-resolution and fetch refuses before dispatch, then re-admits once", async () => {
		advanceClockAfterResolve = 300_001;
		const { result } = await run();
		expect(result?.stopReason).toBe("stop");
		expect(outcomes.map(entry => entry.outcome.code)).toEqual(["resolution_refused", "success"]);
		expect(outcomes[0]?.outcome).toMatchObject({
			startedAt: null,
			dispatch: "not_dispatched",
			refusalReason: "billing_unknown",
		});
		expect(requests).toHaveLength(1);
		expect(new Set(outcomes.map(entry => entry.grant.attemptId)).size).toBe(2);
	});

	it("an abort while the request is in flight settles exactly one cancelled outcome", async () => {
		const controller = new AbortController();
		const gate = Promise.withResolvers<void>();
		messageScript = [
			async () => {
				controller.abort();
				await gate.promise;
				return okResponse();
			},
		];
		await run({ signal: controller.signal });
		gate.resolve();
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]?.outcome.code).toBe("cancelled");
		expect(requests).toHaveLength(1);
	});

	it("fails closed on a non-Anthropic transport without a provider request", async () => {
		const other = { ...claude, api: "openai-completions", provider: "openai" } as unknown as Model<Api>;
		const stream = streamSimple(other, ctx, { apiKey: resolver, fetch: messagesFetch } as SimpleStreamOptions);
		let caught: unknown;
		try {
			for await (const _ of stream) {
				// drain
			}
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ManagedDispatchRefusedError);
		expect(requests).toHaveLength(0);
		expect(outcomes).toHaveLength(0);
	});

	describe("nonstreaming withAuth", () => {
		const authFailure = Object.assign(new Error("401 authentication_error"), { status: 401 });

		it("defaults to no_replay: one attempt, one auth_failed outcome, error surfaces", async () => {
			let calls = 0;
			await expect(
				withAuth(
					resolver,
					async () => {
						calls += 1;
						throw authFailure;
					},
					{ managed: { sessionId: "s", modelId: claude.id }, now: () => clock },
				),
			).rejects.toBe(authFailure);
			expect(calls).toBe(1);
			expect(outcomes.map(entry => entry.outcome.code)).toEqual(["auth_failed"]);
		});

		it("provider_only callbacks re-admit with the previous outcome and settle each attempt once", async () => {
			let calls = 0;
			const value = await withAuth(
				resolver,
				async key => {
					calls += 1;
					if (calls === 1) {
						// The host moves to B after seeing the failed attempt.
						selected = "b";
						throw authFailure;
					}
					return key;
				},
				{ managed: { sessionId: "s", modelId: claude.id }, replayPolicy: "provider_only", now: () => clock },
			);
			expect(value).toBe("sk-ant-oat01-b");
			expect(calls).toBe(2);
			expect(hostCalls[1]?.previous?.code).toBe("auth_failed");
			expect(outcomes.map(entry => entry.outcome.code)).toEqual(["auth_failed", "success"]);
			expect(new Set(outcomes.map(entry => entry.grant.attemptId)).size).toBe(2);
		});
	});
});
