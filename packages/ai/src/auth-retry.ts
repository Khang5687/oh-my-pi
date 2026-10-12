import { extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import type {
	LimitsApi,
	ManagedAdmissionBinding,
	ManagedAttemptOutcome,
	ManagedCallContext,
	ManagedReplayPolicy,
	ManagedRoutingDriver,
	OAuthAccess,
	OAuthApi,
	OAuthRequestIdentity,
	RoutingRefusalCode,
} from "./auth/types";
import * as AIError from "./error";
import { isAuthRetryableError, isInvalidatedOAuthTokenError } from "./error/auth-classify";
import { isAccountPolicyError, isUsageLimit } from "./error/flags";
import { isConcurrencyCapExclusion, isUsageLimitOutcome } from "./error/rate-limit";
import { type HeadersLike, getHeadersFromError, getRetryAfterMsFromHeaders } from "./utils/retry-after";
import { parseClaudeRateLimitHeaders } from "./usage/claude";
import { type RoutingWindow, readRoutingObservation } from "./usage";
import type { RoutingQuotaBlock } from "./auth/rank";

/**
 * Context passed to an {@link ApiKeyResolver} on each resolution attempt.
 *
 * The `error`/`lastChance` pair preserves the legacy a/b/c resolver contract
 * shared by streaming ({@link streamSimple}) and non-streaming ({@link withAuth})
 * drivers:
 * - `error === undefined` → **initial resolve** (no force-refresh; cheap, may
 *   return a locally-cached not-yet-expired token).
 * - `error !== undefined && !lastChance` → **step (b): refresh the SAME
 *   account** (force a token re-mint / await an in-flight broker refresh).
 * - `error !== undefined && lastChance` → **step (c): switch account**
 *   (invalidate/usage-limit the current credential and rotate to a sibling).
 *
 * Current drivers give an ordinary 401/auth failure one step (b) before
 * repeating step (c) through distinct siblings. Account-scoped policy denials,
 * 403s, and usage-limit failures skip refresh. Rotation stops when the resolver
 * returns `undefined`, cycles, or hits {@link AUTH_RETRY_MAX_ATTEMPTS}.
 */
export interface ApiKeyResolveContext {
	/** True when the resolver should rotate to a sibling credential. */
	lastChance: boolean;
	/** The auth error that triggered this re-resolution, or `undefined` on the initial resolve. */
	error: unknown;
	/** Bearer used by the failed attempt, when the caller can expose it. */
	previousKey?: string;
	/** Caller cancel signal, threaded into any credential refresh / rotation work. */
	signal?: AbortSignal;
	/** The logical model call this resolution belongs to, when the resolver is managed. */
	managedCall?: ManagedCallContext;
	/** Outcome of the managed attempt that just ended, so the host can re-admit from evidence. */
	previousOutcome?: ManagedAttemptOutcome;
}

/**
 * Resolves the API key to send for a request, retried through the a/b/c policy
 * described on {@link ApiKeyResolveContext}.
 */
export interface ResolvedApiKey {
	apiKey: string;
	/** Durable row id of the credential that supplied this bearer, when known. */
	credentialId?: number;
	/**
	 * Resolved after `LimitsApi.rotate` slept out a sibling's short block
	 * (`afterSiblingWait`): the driver accepts this bearer even if the request
	 * already sent it before that block.
	 */
	afterSiblingWait?: boolean;
	/** Non-secret request scope belonging to this bearer, replaced on account rotation. */
	oauthIdentity?: OAuthRequestIdentity;
	/** Present only for host-managed routing: the admission this bearer was granted under. */
	managedAdmission?: ManagedAdmissionBinding;
}

/** A resolution that carries its managed admission. */
export type ManagedResolvedApiKey = ResolvedApiKey & { managedAdmission: ManagedAdmissionBinding };

/** Thrown by {@link ManagedAdmissionBinding.beforeDispatch}: the grant no longer holds at the HTTP boundary. */
export class ManagedDispatchRefusedError extends Error {
	readonly code: RoutingRefusalCode;
	readonly retryAfterMs: number | null;
	constructor(code: RoutingRefusalCode, retryAfterMs: number | null = null) {
		super(`Managed admission refused before dispatch: ${code}`);
		this.name = "ManagedDispatchRefusedError";
		this.code = code;
		this.retryAfterMs = retryAfterMs;
	}
}

/** Narrow a resolution to one that carries a managed admission. */
export function managedAdmissionOf(resolved: ApiKeyResolution): ManagedAdmissionBinding | undefined {
	return typeof resolved === "object" ? resolved?.managedAdmission : undefined;
}

/**
 * Wrap a binding so `outcome` reaches the host exactly once and `started` at most once, and the
 * attempt can be settled by whichever layer notices the end first. `settle` is a no-op after that.
 */
export interface GuardedManagedAdmission extends ManagedAdmissionBinding {
	/** The recorded outcome, or undefined while the attempt is still open. */
	readonly settled: ManagedAttemptOutcome | undefined;
	readonly startedAt: number | null;
}

export function guardManagedAdmission(binding: ManagedAdmissionBinding): GuardedManagedAdmission {
	let settled: ManagedAttemptOutcome | undefined;
	let startedAt: number | null = null;
	return {
		grant: binding.grant,
		call: binding.call,
		get settled() {
			return settled;
		},
		get startedAt() {
			return startedAt;
		},
		beforeDispatch: signal => binding.beforeDispatch(signal),
		started(at) {
			if (settled || startedAt !== null) return;
			startedAt = at;
			binding.started(at);
		},
		outcome(outcome) {
			if (settled) return;
			settled = outcome;
			binding.outcome(outcome);
		},
	};
}

/** Outcome for an attempt that never reached the provider. */
export function undispatchedOutcome(
	code: "resolution_refused" | "cancelled",
	finishedAt: number,
	refusalReason: RoutingRefusalCode | null,
	retryAfterMs: number | null = null,
): ManagedAttemptOutcome {
	return {
		startedAt: null,
		finishedAt,
		code,
		dispatch: "not_dispatched",
		replaySafe: true,
		refusalReason,
		retryAfterMs,
		quotaBlocks: [],
		windows: [],
	};
}

export type ApiKeyResolution = string | ResolvedApiKey | undefined;

export type ApiKeyResolver = ((ctx: ApiKeyResolveContext) => Promise<ApiKeyResolution> | ApiKeyResolution) & {
	/** Host admission authority; present only for resolvers that serve host-managed routing. */
	readonly managedRouting?: ManagedRoutingDriver;
	/** Set by {@link seedApiKeyResolver}: the call the seeded admission belongs to, so a stream reuses it. */
	readonly seededManagedCall?: ManagedCallContext;
};

/** Extract the bearer while preserving optional credential provenance for streaming callers. */
export function resolvedApiKeyBearer(resolved: ApiKeyResolution): string | undefined {
	return (typeof resolved === "string" ? resolved : resolved?.apiKey) || undefined;
}

/**
 * Mark a post-rotation resolution as following a sibling-unblock wait so the
 * retry driver may resend a bearer it already tried. Used by the rotating
 * resolvers (`KeyCascade.resolver`, coding-agent `createApiKeyResolver`).
 */
export function markAfterSiblingWait(resolved: ApiKeyResolution): ApiKeyResolution {
	const apiKey = resolvedApiKeyBearer(resolved);
	if (apiKey === undefined) return resolved;
	return typeof resolved === "string"
		? { apiKey, afterSiblingWait: true }
		: { ...resolved, apiKey, afterSiblingWait: true };
}

/** A static bearer string, or a {@link ApiKeyResolver} that mints/rotates one. */
export type ApiKey = string | ApiKeyResolver;

/** Keyless-provider credential marker; transports must not send it in authentication headers. */
export const NO_AUTH_SENTINEL = "N/A";

/** Narrows {@link ApiKey} to its resolver form. */
export function isApiKeyResolver(key: ApiKey | undefined): key is ApiKeyResolver {
	return typeof key === "function";
}

/**
 * Performs the initial resolve of an {@link ApiKey} (`error: undefined`,
 * `lastChance: false`). Static keys pass through unchanged.
 */
export async function resolveApiKeyOnce(
	key: ApiKey | undefined,
	signal?: AbortSignal,
	onResolved?: (resolved: ApiKeyResolution) => void,
	managedCall?: ManagedCallContext,
): Promise<string | undefined> {
	if (key === undefined) return undefined;
	if (isApiKeyResolver(key)) {
		const resolved = await key({ lastChance: false, error: undefined, signal, managedCall });
		onResolved?.(resolved);
		return resolvedApiKeyBearer(resolved);
	}
	return key;
}

/**
 * Wraps a resolver with a credential already selected for this request.
 *
 * Callers that preflight credentials can pass the returned resolver to the
 * auth-retry driver without making the driver know about that preflight: the
 * first initial resolution reuses `seed` (including its credential identity),
 * and all later resolutions delegate to `resolver`.
 */
export function seedApiKeyResolver(seed: ApiKeyResolution, resolver: ApiKeyResolver): ApiKeyResolver {
	let seedPending = resolvedApiKeyBearer(seed) !== undefined;
	const seeded: ApiKeyResolver = ctx => {
		// A managed seed answers only the initial resolve of the call it was admitted for; every
		// later attempt (previousOutcome set) goes back to the host for a fresh grant.
		if (seedPending && ctx.error === undefined && ctx.previousOutcome === undefined) {
			seedPending = false;
			return seed;
		}
		return resolver(ctx);
	};
	return resolver.managedRouting
		? Object.assign(seeded, {
				managedRouting: resolver.managedRouting,
				seededManagedCall: managedAdmissionOf(seed)?.call,
			})
		: seeded;
}

/** Start a managed logical call when `key` is a managed resolver; undefined for every other key. */
export function beginManagedCall(
	key: ApiKey | undefined,
	input: {
		sessionId: string | undefined;
		modelId: string;
		purpose?: string;
		signal?: AbortSignal;
		replayPolicy?: ManagedReplayPolicy;
	},
): ManagedCallContext | undefined {
	const driver = isApiKeyResolver(key) ? key.managedRouting : undefined;
	if (!driver) return undefined;
	return driver.beginCall({
		sessionId: input.sessionId ?? "",
		modelId: input.modelId,
		purpose: input.purpose ?? "other_auxiliary",
		signal: input.signal,
		replayPolicy: input.replayPolicy ?? "no_replay",
	});
}

// Re-exported from the error module (its new home); see error/auth-classify.ts.
export { isAuthRetryableError };

/**
 * Legacy a/b/c retry sequence retained for public compatibility:
 * `false` → refresh-same, `true` → rotate/switch. Current drivers may repeat
 * sibling rotation until a termination guard fires.
 */
export const AUTH_RETRY_STEPS: readonly boolean[] = [false, true];

export const AUTH_RETRY_MAX_ATTEMPTS = 64;

function isDirectCredentialRotationError(error: unknown): boolean {
	if (isAccountPolicyError(error)) return true;
	if (isUsageLimit(error) || isInvalidatedOAuthTokenError(error)) return true;
	const status = AIError.status(error);
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	// A 403 normally means a valid token lacks access, so rotate through
	// siblings. A concurrency-cap 403 is transient instead; do not burn a
	// sibling before the caller's backoff layer can retry it.
	const isForbidden =
		status === 403 ||
		(status === undefined && message !== undefined && extractHttpStatusFromError({ message }) === 403);
	if (isForbidden && !isConcurrencyCapExclusion(status, message)) return true;
	return isUsageLimitOutcome(status, message);
}

/** Managed call and the outcome of the attempt that just failed, forwarded to a managed resolver. */
export interface ManagedRetryContext {
	call: ManagedCallContext;
	previousOutcome?: ManagedAttemptOutcome;
}

/** Resolve a single retry step, swallowing resolver failures into `undefined`. */
export async function resolveRetryKey(
	resolver: ApiKeyResolver,
	lastChance: boolean,
	error: unknown,
	signal?: AbortSignal,
	previousKey?: string,
	onResolved?: (resolved: ApiKeyResolution) => void,
	managed?: ManagedRetryContext,
): Promise<string | undefined> {
	try {
		const rotateSibling = lastChance || (!lastChance && isDirectCredentialRotationError(error));
		const resolved = await resolver({
			lastChance: rotateSibling,
			error,
			signal,
			previousKey,
			managedCall: managed?.call,
			previousOutcome: managed?.previousOutcome,
		});
		onResolved?.(resolved);
		return resolvedApiKeyBearer(resolved);
	} catch {
		return undefined;
	}
}

export interface AuthRetryKeyState {
	/** Bearer strings already sent during this logical operation. */
	attemptedKeys: Set<string>;
	/** Bearer used by the most recent failed attempt. */
	lastKey: string;
	/** Whether the current credential already consumed its 401 refresh-same retry. */
	refreshedCurrent: boolean;
	/** Whether this operation already replayed once after an explicit token-refresh request. */
	tokenRefreshReplayUsed?: boolean;
	/** Total outbound attempts accepted for this logical operation, including the initial request. */
	attempts: number;
}

export function createAuthRetryKeyState(initialKey: string): AuthRetryKeyState {
	return {
		attemptedKeys: new Set([initialKey]),
		lastKey: initialKey,
		refreshedCurrent: false,
		tokenRefreshReplayUsed: false,
		attempts: 1,
	};
}

function acceptRetryKey(
	state: AuthRetryKeyState,
	key: string,
	refreshedCurrent: boolean,
	afterSiblingWait = false,
): string | undefined {
	if ((!afterSiblingWait && state.attemptedKeys.has(key)) || state.attempts >= AUTH_RETRY_MAX_ATTEMPTS) {
		return undefined;
	}
	state.attemptedKeys.add(key);
	state.attempts += 1;
	state.lastKey = key;
	state.refreshedCurrent = refreshedCurrent;
	return key;
}

export async function resolveNextAuthRetryKey(
	state: AuthRetryKeyState,
	resolver: ApiKeyResolver,
	error: unknown,
	signal?: AbortSignal,
	onResolved?: (resolved: ApiKeyResolution) => void,
	managed?: ManagedRetryContext,
): Promise<string | undefined> {
	if (signal?.aborted) return undefined;
	if (state.attempts >= AUTH_RETRY_MAX_ATTEMPTS) return undefined;
	if (error instanceof AIError.OAuthError && error.kind === "token-refresh") {
		if (state.tokenRefreshReplayUsed) return undefined;
		state.tokenRefreshReplayUsed = true;
		const refreshed = await resolveRetryKey(resolver, false, error, signal, state.lastKey, onResolved, managed);
		state.refreshedCurrent = true;
		if (signal?.aborted || refreshed === undefined) return undefined;
		return acceptRetryKey(state, refreshed, true);
	}
	const directRotation = isDirectCredentialRotationError(error);
	if (!directRotation) {
		if (!state.refreshedCurrent) {
			const refreshed = await resolveRetryKey(resolver, false, error, signal, state.lastKey, onResolved, managed);
			state.refreshedCurrent = true;
			if (signal?.aborted) return undefined;
			if (refreshed !== undefined) {
				const accepted = acceptRetryKey(state, refreshed, true);
				if (accepted !== undefined) return accepted;
			}
		}
	}

	if (signal?.aborted) return undefined;
	let afterSiblingWait = false;
	const rotated = await resolveRetryKey(
		resolver,
		true,
		error,
		signal,
		state.lastKey,
		resolved => {
			afterSiblingWait = typeof resolved === "object" && resolved.afterSiblingWait === true;
			onResolved?.(resolved);
		},
		managed,
	);
	if (signal?.aborted || rotated === undefined) return undefined;
	return acceptRetryKey(state, rotated, !directRotation, afterSiblingWait);
}

function oauthCredentialIdentity(access: OAuthAccess): string {
	return access.credentialId !== undefined ? `credential:${access.credentialId}` : `bearer:${access.accessToken}`;
}

async function runOAuthAttempt<T>(
	access: OAuthAccess,
	attempt: (access: OAuthAccess) => Promise<T>,
	isAuthError: (error: unknown) => boolean,
): Promise<{ ok: true; result: T } | { ok: false; error: unknown }> {
	try {
		return { ok: true, result: await attempt(access) };
	} catch (error) {
		if (!isAuthError(error)) throw error;
		return { ok: false, error };
	}
}

/**
 * Runs an auth-protected operation through the central a/b/c retry policy.
 *
 * - A static string key (or any non-resolver) → a single `attempt` with no
 *   retry (identical to the legacy static-key path).
 * - A resolver → initial `attempt`, then resolver-driven retries until the
 *   applicable policy is exhausted, the resolver declines or cycles, or the
 *   operation reaches {@link AUTH_RETRY_MAX_ATTEMPTS}. An explicit typed
 *   token-refresh request gets exactly one refresh-current replay and never
 *   enters sibling rotation. Ordinary 401/auth failures get one refresh-same,
 *   then rotate through distinct siblings; 403/usage-limit failures skip the
 *   refresh and rotate directly.
 *
 * Used by non-streaming consumers (image generation, web search, completion
 * helpers). The streaming driver in `stream.ts` implements the same policy with
 * its replay-safe buffering machinery.
 */
export interface WithAuthOptions {
	isAuthError?: (error: unknown) => boolean;
	signal?: AbortSignal;
	missingKeyMessage?: string;
	/**
	 * Managed resolvers only. `managedCall` reuses a call the caller already began; otherwise one is
	 * started from `managed`. The callback is never replayed after dispatch unless `replayPolicy` is
	 * `provider_only`, which only callbacks whose entire effect is one provider request may declare.
	 */
	managedCall?: ManagedCallContext;
	managed?: { sessionId?: string; modelId: string; purpose?: string };
	replayPolicy?: ManagedReplayPolicy;
	/** Injected clock for outcome timestamps. */
	now?: () => number;
}

/** Bearer-level managed retry loop: one admission, `beforeDispatch`, `started` and outcome per attempt. */
async function withManagedAuth<T>(
	resolver: ApiKeyResolver,
	attempt: (key: string) => Promise<T>,
	opts: WithAuthOptions | undefined,
	isAuthError: (error: unknown) => boolean,
	missingKey: () => Error,
): Promise<T> {
	const driver = resolver.managedRouting;
	const signal = opts?.signal;
	const now = opts?.now ?? Date.now;
	const call =
		opts?.managedCall ??
		(driver && opts?.managed
			? driver.beginCall({
					sessionId: opts.managed.sessionId ?? "",
					modelId: opts.managed.modelId,
					purpose: opts.managed.purpose ?? "other_auxiliary",
					signal,
					replayPolicy: opts.replayPolicy ?? "no_replay",
				})
			: undefined);
	if (!call) throw new AIError.ConfigurationError("Managed routing requires a model for withAuth");

	const tried = new Set<string>();
	let previousOutcome: ManagedAttemptOutcome | undefined;
	let lastError: unknown;
	let predispatchRefusals = 0;
	let lastRefusal: unknown;
	for (let attempts = 0; attempts < AUTH_RETRY_MAX_ATTEMPTS; attempts++) {
		if (signal?.aborted) break;
		let resolved: ApiKeyResolution;
		try {
			resolved = await resolver({
				lastChance: false,
				error: lastError,
				signal,
				managedCall: call,
				previousOutcome,
			});
		} catch (error) {
			if (lastError === undefined) throw error;
			break;
		}
		const bearer = resolvedApiKeyBearer(resolved);
		const binding = managedAdmissionOf(resolved);
		if (bearer === undefined || !binding) {
			if (lastError === undefined && lastRefusal === undefined) throw missingKey();
			break;
		}
		const identity = `${binding.grant.accountRef.nativeRowId}\0${bearer}`;
		if (lastError !== undefined && tried.has(identity)) break;
		tried.add(identity);

		const guarded = guardManagedAdmission(binding);
		try {
			await guarded.beforeDispatch(signal);
		} catch (error) {
			const refusal =
				error instanceof ManagedDispatchRefusedError ? error : new ManagedDispatchRefusedError("host_unavailable");
			guarded.outcome(undispatchedOutcome("resolution_refused", now(), refusal.code, refusal.retryAfterMs));
			previousOutcome = guarded.settled;
			lastRefusal = error;
			// One bounded re-admission per refresh; a second pre-dispatch refusal surfaces.
			if (error instanceof ManagedDispatchRefusedError && predispatchRefusals++ < 1) continue;
			throw error;
		}
		const startedAt = now();
		guarded.started(startedAt);
		try {
			const result = await attempt(bearer);
			guarded.outcome(managedSuccessOutcome({ startedAt, finishedAt: now() }));
			return result;
		} catch (error) {
			const outcome = managedFailureOutcome(error, {
				startedAt,
				finishedAt: now(),
				replayUnsafe: false,
				aborted: signal?.aborted === true,
			});
			guarded.outcome(outcome);
			if (!isAuthError(error) || call.replayPolicy === "no_replay") throw error;
			lastError = error;
			previousOutcome = outcome;
		}
	}
	throw lastError ?? lastRefusal ?? new AIError.AbortError();
}

export async function withAuth<T>(
	key: ApiKey | undefined,
	attempt: (key: string) => Promise<T>,
	opts?: WithAuthOptions,
): Promise<T> {
	const isAuthError = opts?.isAuthError ?? isAuthRetryableError;
	const missingKey = (): Error => new AIError.MissingApiKeyError(undefined, opts?.missingKeyMessage);

	if (!isApiKeyResolver(key)) {
		if (key === undefined) throw missingKey();
		return attempt(key);
	}

	const resolver = key;
	if (resolver.managedRouting) return withManagedAuth(resolver, attempt, opts, isAuthError, missingKey);
	const signal = opts?.signal;
	const initialKey = await resolveRetryKey(resolver, false, undefined, signal);
	if (initialKey === undefined) throw missingKey();

	const state = createAuthRetryKeyState(initialKey);
	let lastError: unknown;
	try {
		return await attempt(initialKey);
	} catch (error) {
		if (!isAuthError(error)) throw error;
		lastError = error;
	}

	while (true) {
		const nextKey = await resolveNextAuthRetryKey(state, resolver, lastError, signal);
		if (nextKey === undefined) break;
		try {
			return await attempt(nextKey);
		} catch (error) {
			if (!isAuthError(error)) throw error;
			lastError = error;
		}
	}

	throw lastError;
}

/**
 * Minimal structural slice of `AuthStorage` consumed by {@link withOAuthAccess}.
 * Typed structurally (type-only imports) so this module never takes a runtime
 * dependency on `./auth-storage`.
 */
export interface OAuthAccessSource {
	readonly oauth: Pick<OAuthApi, "access">;
	readonly limits: Pick<LimitsApi, "rotate">;
}

export interface WithOAuthAccessOptions {
	/** Session id for credential stickiness, threaded into every resolve. */
	sessionId?: string;
	signal?: AbortSignal;
	/** Override the retryable-error classifier (default {@link isAuthRetryableError}). */
	isAuthError?: (error: unknown) => boolean;
	/**
	 * Pre-resolved access used for the initial attempt. Callers that already
	 * resolved access for an availability gate pass it here so the helper
	 * doesn't double-resolve (mirrors the gateway resolver's `initialKey`).
	 */
	seed?: OAuthAccess;
	missingAccessMessage?: string;
}

/**
 * {@link withAuth} for OAuth-access consumers: runs an auth-protected
 * operation through the central a/b/c retry policy, handing the attempt the
 * full {@link OAuthAccess} (bearer + identity metadata: `accountId`,
 * `projectId`, `enterpriseUrl`) instead of bare API-key bytes.
 *
 * - initial → `getOAuthAccess` (or `opts.seed`).
 * - typed token-refresh request → one forced refresh-current replay, then stop.
 * - 401/auth failure → one `getOAuthAccess` with `forceRefresh: true` for the
 *   current account, then sibling rotation through distinct credentials.
 * - 403/usage-limit failure → `rotateSessionCredential` directly, without a
 *   force-refresh detour.
 *
 * A refresh-same step may retry a new bearer for the same credential identity;
 * sibling rotation stops when it yields a credential identity
 * (`credentialId ?? accessToken`) or bearer already attempted in this turn.
 * All OAuth attempts share the {@link AUTH_RETRY_MAX_ATTEMPTS} ceiling.
 * Non-auth errors propagate immediately. Use this instead of hand-rolled
 * `getOAuthAccess` + fetch flows so 401s and usage-limits rotate credentials
 * instead of failing the call.
 */
export async function withOAuthAccess<T>(
	storage: OAuthAccessSource,
	provider: string,
	attempt: (access: OAuthAccess) => Promise<T>,
	opts?: WithOAuthAccessOptions,
): Promise<T> {
	const isAuthError = opts?.isAuthError ?? isAuthRetryableError;
	const { sessionId, signal } = opts ?? {};

	let lastAccess = opts?.seed ?? (await storage.oauth.access(provider, sessionId, { signal }));
	if (!lastAccess) {
		throw new AIError.MissingApiKeyError(
			provider,
			opts?.missingAccessMessage ?? `No OAuth credential available for provider: ${provider}`,
		);
	}

	const attemptedBearers = new Set([lastAccess.accessToken]);
	const attemptedCredentialIdentities = new Set([oauthCredentialIdentity(lastAccess)]);
	let attemptCount = 1;
	let refreshedCurrent = false;
	let tokenRefreshReplayUsed = false;
	let attemptResult = await runOAuthAttempt(lastAccess, attempt, isAuthError);
	if (attemptResult.ok) return attemptResult.result;

	let lastError = attemptResult.error;
	while (true) {
		let next: OAuthAccess | undefined;
		if (signal?.aborted || attemptCount >= AUTH_RETRY_MAX_ATTEMPTS) break;
		const tokenRefreshReplay = lastError instanceof AIError.OAuthError && lastError.kind === "token-refresh";
		if (tokenRefreshReplay) {
			if (tokenRefreshReplayUsed) break;
			tokenRefreshReplayUsed = true;
			refreshedCurrent = true;
			try {
				next = await storage.oauth.access(provider, sessionId, { forceRefresh: true, signal });
			} catch {
				next = undefined;
			}
			if (signal?.aborted || !next) break;
			const bearer = next.accessToken;
			if (attemptedBearers.has(bearer) || attemptCount >= AUTH_RETRY_MAX_ATTEMPTS) break;
			attemptedCredentialIdentities.add(oauthCredentialIdentity(next));
			attemptedBearers.add(bearer);
			attemptCount += 1;
			lastAccess = next;
			attemptResult = await runOAuthAttempt(next, attempt, isAuthError);
			if (attemptResult.ok) return attemptResult.result;
			lastError = attemptResult.error;
			continue;
		}

		const directRotation = isDirectCredentialRotationError(lastError);
		if (!directRotation) {
			if (!refreshedCurrent) {
				refreshedCurrent = true;
				try {
					next = await storage.oauth.access(provider, sessionId, {
						forceRefresh: true,
						refreshReason: AIError.status(lastError) === 401 ? "auth-recovery" : undefined,
						signal,
					});
				} catch {
					next = undefined;
				}
				if (signal?.aborted) break;
				if (next) {
					const bearer = next.accessToken;
					if (!attemptedBearers.has(bearer) && attemptCount < AUTH_RETRY_MAX_ATTEMPTS) {
						attemptedCredentialIdentities.add(oauthCredentialIdentity(next));
						attemptedBearers.add(bearer);
						attemptCount += 1;
						lastAccess = next;
						attemptResult = await runOAuthAttempt(next, attempt, isAuthError);
						if (attemptResult.ok) return attemptResult.result;
						lastError = attemptResult.error;
						continue;
					}
				}
			}
		}

		if (signal?.aborted || attemptCount >= AUTH_RETRY_MAX_ATTEMPTS) break;
		let afterSiblingWait = false;
		try {
			const rotation = await storage.limits.rotate(provider, sessionId, {
				error: lastError,
				signal,
				apiKey: lastAccess.accessToken,
				credentialId: lastAccess.credentialId,
			});
			if (!rotation.switched) break;
			afterSiblingWait = rotation.afterSiblingWait === true;
			next = await storage.oauth.access(provider, sessionId, { signal });
		} catch {
			next = undefined;
		}
		if (signal?.aborted || !next) break;
		const credentialIdentity = oauthCredentialIdentity(next);
		if (
			(!afterSiblingWait &&
				(attemptedCredentialIdentities.has(credentialIdentity) || attemptedBearers.has(next.accessToken))) ||
			attemptCount >= AUTH_RETRY_MAX_ATTEMPTS
		) {
			break;
		}
		attemptedCredentialIdentities.add(credentialIdentity);
		attemptedBearers.add(next.accessToken);
		attemptCount += 1;
		lastAccess = next;
		refreshedCurrent = !directRotation;
		attemptResult = await runOAuthAttempt(next, attempt, isAuthError);
		if (attemptResult.ok) return attemptResult.result;
		lastError = attemptResult.error;
	}

	throw lastError;
}

// ---------------------------------------------------------------------------
// Managed attempt outcomes
// ---------------------------------------------------------------------------

function lowercaseHeaders(headers: HeadersLike): Record<string, string> {
	const out: Record<string, string> = {};
	if (!headers) return out;
	if (headers instanceof Headers) {
		for (const [key, value] of headers.entries()) out[key.toLowerCase()] = value;
		return out;
	}
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") out[key.toLowerCase()] = value;
	}
	return out;
}

/** Quantitative windows the provider reported in unified rate-limit response headers. */
export function managedWindowsFromHeaders(headers: HeadersLike, nowMs: number): RoutingWindow[] {
	const report = parseClaudeRateLimitHeaders(lowercaseHeaders(headers), nowMs);
	return readRoutingObservation(report)?.windowObservations ?? [];
}

/**
 * Confirmed exhaustion from an authenticated Messages rejection: a window the provider itself reports
 * at utilization>=1 with a future reset. A bare 429, concurrency or body-only text never qualifies.
 */
function exhaustedWindows(windows: readonly RoutingWindow[], nowMs: number): RoutingQuotaBlock[] {
	const blocks: RoutingQuotaBlock[] = [];
	for (const window of windows) {
		if (window.usedFraction === null || window.usedFraction < 1) continue;
		if (window.resetAt === null || window.resetAt <= nowMs) continue;
		blocks.push({
			limitId: window.id,
			scope: window.scope,
			resetAt: window.resetAt,
			observedAt: nowMs,
			source: "provider-rejection",
			confirmed: true,
		});
	}
	return blocks;
}

/** Outcome of a dispatched attempt that produced a response. */
export function managedSuccessOutcome(input: {
	startedAt: number;
	finishedAt: number;
	headers?: HeadersLike;
}): ManagedAttemptOutcome {
	return {
		startedAt: input.startedAt,
		finishedAt: input.finishedAt,
		code: "success",
		dispatch: "dispatched",
		replaySafe: false,
		refusalReason: null,
		retryAfterMs: null,
		quotaBlocks: [],
		windows: managedWindowsFromHeaders(input.headers, input.finishedAt),
	};
}

/**
 * Map a failed dispatched attempt onto the allowlisted outcome vocabulary. Never carries error text.
 * `replayUnsafe` is true once output reached the consumer or a tool call may have escaped.
 */
export function managedFailureOutcome(
	error: unknown,
	input: { startedAt: number; finishedAt: number; replayUnsafe: boolean; aborted?: boolean },
): ManagedAttemptOutcome {
	const headers = getHeadersFromError(error);
	const windows = managedWindowsFromHeaders(headers, input.finishedAt);
	const status = AIError.status(error);
	const base = {
		startedAt: input.startedAt,
		finishedAt: input.finishedAt,
		dispatch: input.replayUnsafe ? ("replay_unsafe" as const) : ("dispatched" as const),
		replaySafe: !input.replayUnsafe,
		refusalReason: null,
		windows,
	};
	if (input.aborted || error instanceof AIError.AbortError) {
		return { ...base, code: "cancelled", retryAfterMs: null, quotaBlocks: [] };
	}
	const retryAfterMs = getRetryAfterMsFromHeaders(headers) ?? null;
	if (status === 429) {
		const quotaBlocks = exhaustedWindows(windows, input.finishedAt);
		if (quotaBlocks.length > 0) return { ...base, code: "quota_exhausted", retryAfterMs, quotaBlocks };
		return { ...base, code: "rate_limited", retryAfterMs, quotaBlocks: [] };
	}
	if (status === 401 || status === 403 || isInvalidatedOAuthTokenError(error)) {
		return { ...base, code: "auth_failed", retryAfterMs: null, quotaBlocks: [] };
	}
	if (status === undefined) return { ...base, code: "network_failed", retryAfterMs: null, quotaBlocks: [] };
	return { ...base, code: "provider_failed", retryAfterMs, quotaBlocks: [] };
}

// ---------------------------------------------------------------------------
// Per-call attempt source
// ---------------------------------------------------------------------------

/** What a provider needs to build exactly one HTTP request under an admitted grant. */
export interface AdmittedManagedAttempt {
	apiKey: string;
	credentialId: number | undefined;
	oauthIdentity: OAuthRequestIdentity | undefined;
}

/**
 * Supplies one admitted grant per actual provider HTTP attempt of a single logical call.
 *
 * The first attempt uses the seeded resolution; every later attempt (provider retry, body repair,
 * empty-completion retry) asks the host again with the previous outcome, so each attempt carries its
 * own grant, `beforeDispatch` guard and exactly-one outcome. A pre-dispatch refusal triggers one
 * bounded re-admission; a second refusal surfaces as {@link ManagedDispatchRefusedError}.
 */
export class ManagedAttemptSource {
	readonly call: ManagedCallContext;
	readonly #readmit: (
		previous: ManagedAttemptOutcome | undefined,
		signal: AbortSignal | undefined,
	) => Promise<ApiKeyResolution>;
	readonly #now: () => number;
	#seed: ManagedResolvedApiKey | undefined;
	#open: GuardedManagedAdmission | undefined;
	#last: ManagedAttemptOutcome | undefined;
	#startedAt: number | null = null;

	constructor(
		call: ManagedCallContext,
		seed: ManagedResolvedApiKey,
		readmit: (
			previous: ManagedAttemptOutcome | undefined,
			signal: AbortSignal | undefined,
		) => Promise<ApiKeyResolution>,
		now: () => number = Date.now,
	) {
		this.call = call;
		this.#seed = seed;
		this.#readmit = readmit;
		this.#now = now;
	}

	/** Outcome of the most recently settled attempt. */
	get lastOutcome(): ManagedAttemptOutcome | undefined {
		return this.#last;
	}

	/** Admit the next HTTP attempt and run its `beforeDispatch` guard. Throws when the host declines. */
	async admit(signal?: AbortSignal): Promise<AdmittedManagedAttempt> {
		this.settleOpen(undefined);
		for (let refusals = 0; ; refusals++) {
			let resolved: ApiKeyResolution;
			if (this.#seed) {
				resolved = this.#seed;
				this.#seed = undefined;
			} else {
				if (signal?.aborted) throw new ManagedDispatchRefusedError("cancelled");
				resolved = await this.#readmit(this.#last, signal);
			}
			const bearer = resolvedApiKeyBearer(resolved);
			const binding = managedAdmissionOf(resolved);
			if (bearer === undefined || !binding) {
				throw new ManagedDispatchRefusedError(this.#last?.refusalReason ?? "host_unavailable");
			}
			const guarded = guardManagedAdmission(binding);
			try {
				await guarded.beforeDispatch(signal);
			} catch (error) {
				const refusal =
					error instanceof ManagedDispatchRefusedError
						? error
						: new ManagedDispatchRefusedError("host_unavailable");
				guarded.outcome(undispatchedOutcome("resolution_refused", this.#now(), refusal.code, refusal.retryAfterMs));
				this.#last = guarded.settled;
				if (refusals >= 1) throw refusal;
				continue;
			}
			this.#open = guarded;
			this.#startedAt = null;
			const credential = typeof resolved === "object" ? resolved : undefined;
			return { apiKey: bearer, credentialId: credential?.credentialId, oauthIdentity: credential?.oauthIdentity };
		}
	}

	/** Immediately before the provider request leaves. */
	started(): void {
		const open = this.#open;
		if (!open || this.#startedAt !== null) return;
		this.#startedAt = this.#now();
		open.started(this.#startedAt);
	}

	succeed(headers?: HeadersLike): void {
		const open = this.#open;
		if (!open) return;
		this.#settle(
			open,
			managedSuccessOutcome({ startedAt: this.#startedAt ?? this.#now(), finishedAt: this.#now(), headers }),
		);
	}

	fail(error: unknown, input: { replayUnsafe: boolean; aborted: boolean }): void {
		this.settleOpen(error, input);
	}

	/** Settle any still-open attempt; the last line of defence for exactly-one outcome. */
	settleOpen(
		error: unknown,
		input: { replayUnsafe: boolean; aborted: boolean } = { replayUnsafe: false, aborted: false },
	): void {
		const open = this.#open;
		if (!open) return;
		const finishedAt = this.#now();
		const outcome =
			this.#startedAt === null
				? undispatchedOutcome("cancelled", finishedAt, null)
				: managedFailureOutcome(error, { startedAt: this.#startedAt, finishedAt, ...input });
		this.#settle(open, outcome);
	}

	#settle(open: GuardedManagedAdmission, outcome: ManagedAttemptOutcome): void {
		open.outcome(outcome);
		this.#last = open.settled ?? outcome;
		this.#open = undefined;
	}
}
