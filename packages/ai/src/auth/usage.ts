import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { $pickenv, logger } from "@oh-my-pi/pi-utils";
import { getEnvApiKey } from "../env-api-key";
import * as AIError from "../error";
import type { OAuthCredentials } from "../registry/oauth/types";
import type { Provider } from "../types";
import {
	currentIncludedBilling,
	mergeHeaderRoutingObservation,
	type RoutingBinding,
	type RoutingObservation,
	readRoutingObservation,
	resolveUsedFraction,
	ROUTING_BILLING_MAX_AGE_MS,
	unknownBilling,
} from "../usage";
import type {
	ClientUsageReport,
	ClientUsageSummary,
	CredentialRankingContext,
	UsageCredential,
	UsageFetchParams,
	UsageHistoryEntry,
	UsageHistoryQuery,
	UsageLimit,
	UsageLogger,
	UsageProvider,
	UsageReport,
} from "../usage";
import { claudeOAuthBaseUrl, DEFAULT_CLAUDE_API_BASE_URL, normalizeClaudeApiBaseUrl } from "../usage/claude-api";
import { DEFAULT_USAGE_PROVIDERS } from "../usage/registry";
import { raceSignal } from "./abort";
import type { SessionAffinity } from "./affinity";
import type { CredentialBlocks } from "./blocks";
import type { KeyOverrides } from "./cascade";
import {
	buildUsageCredential,
	oauthUsageRequest,
	failureCooldownMs,
	USAGE_FAILURE_BACKOFF_MS,
	USAGE_HEADER_INGEST_INTERVAL_MS,
	usageCacheIdentity,
	usageRequest,
} from "./usage-cache";
import type { UsageCache, UsageRequestDescriptor } from "./usage-cache";
import type { CredentialPool } from "./pool";
import type { RankingStrategyResolver } from "../usage/registry";
import { mergeRefreshedOrganizationScope, OAUTH_REFRESH_SKEW_MS } from "./refresh";
import type { OAuthRefresher } from "./refresh";
import { USAGE_REPORT_TTL_MS } from "./sqlite-credential-store";
import type { AuthCredentialStore } from "./store";
import { isStoreNamespace } from "./types";
import type {
	AuthCredential,
	OAuthCredential,
	ObservedUsageInput,
	RoutingExactUsageRequest,
	RoutingExactUsageResult,
	RoutingExactUsageUnknownCode,
	UsageApi,
	UsageCachePeekRequest,
} from "./types";
import {
	dedupeUsageReports,
	isUsageLimitExhausted,
	scopedUsageLimits,
	usageReportMetadataValue,
	usageReportScopeAccountId,
} from "./usage-report";

const MAX_EXACT_MODEL_ID_LENGTH = 256;

/** True only for the first-party Anthropic API root, optionally with its `/v1` or `/api/oauth` suffix. */
export function isTrustedClaudeBaseUrl(baseUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return false;
	if (url.origin !== DEFAULT_CLAUDE_API_BASE_URL) return false;
	return normalizeClaudeApiBaseUrl(baseUrl) === DEFAULT_CLAUDE_API_BASE_URL;
}

/** Validate an exact-refresh request's shape; returns the rejection code, or null when well-formed. */
export function exactUsageRequestRejection(
	request: Pick<RoutingExactUsageRequest, "accountRef" | "provider" | "modelId" | "baseUrl" | "nowMs">,
): RoutingExactUsageUnknownCode | null {
	const { accountRef, modelId } = request;
	if (
		request.provider !== "anthropic" ||
		!isStoreNamespace(accountRef?.storeNamespace) ||
		!Number.isSafeInteger(accountRef.nativeRowId) ||
		accountRef.nativeRowId < 1 ||
		!(
			modelId === null ||
			(typeof modelId === "string" && modelId.length > 0 && modelId.length <= MAX_EXACT_MODEL_ID_LENGTH)
		) ||
		typeof request.baseUrl !== "string" ||
		!Number.isFinite(request.nowMs)
	) {
		return "invalid_request";
	}
	return isTrustedClaudeBaseUrl(request.baseUrl) ? null : "untrusted_endpoint";
}

/** Whether an observation belongs to exactly this row, endpoint and (when both sides know it) account/org. */
function observationBelongsToRow(
	observation: RoutingObservation,
	ref: { storeNamespace: string; nativeRowId: number },
	baseUrl: string,
	credential: { accountId?: string; orgId?: string },
): boolean {
	if (observation.storeNamespace !== ref.storeNamespace || observation.nativeRowId !== ref.nativeRowId) return false;
	if (observation.endpoint !== `${claudeOAuthBaseUrl(baseUrl)}/usage`) return false;
	const { accountId, orgId } = credential;
	if (observation.accountId !== null && accountId !== undefined && observation.accountId !== accountId) return false;
	if (observation.organizationId !== null && orgId !== undefined && observation.organizationId !== orgId) return false;
	return true;
}

interface ExactUsageFlight {
	promise: Promise<RoutingObservation | RoutingExactUsageUnknownCode>;
	controller: AbortController;
	waiters: number;
}

/** Convert an OAuth usage credential into a refreshable stored shape; used by probes and health. */
export function buildRefreshableOauthCredential(credential: UsageCredential): OAuthCredential | null {
	if (!credential.accessToken || !credential.refreshToken || credential.expiresAt === undefined) {
		return null;
	}
	return {
		type: "oauth",
		access: credential.accessToken,
		refresh: credential.refreshToken,
		expires: credential.expiresAt,
		accountId: credential.accountId,
		projectId: credential.projectId,
		email: credential.email,
		orgId: credential.orgId,
		orgName: credential.orgName,
		enterpriseUrl: credential.enterpriseUrl,
		apiEndpoint: credential.apiEndpoint,
		region: credential.region,
		inferenceRegion: credential.inferenceRegion,
		activeOrganizationId: credential.activeOrganizationId,
	};
}

/** Merge refreshed OAuth tokens and identity into a usage credential; used by probes and health. */
export function mergeRefreshedUsageCredential(
	credential: UsageCredential,
	refreshed: OAuthCredentials,
): UsageCredential {
	return {
		...credential,
		accessToken: refreshed.access,
		refreshToken: refreshed.refresh,
		expiresAt: refreshed.expires,
		accountId: refreshed.accountId ?? credential.accountId,
		projectId: refreshed.projectId ?? credential.projectId,
		email: refreshed.email ?? credential.email,
		enterpriseUrl: refreshed.enterpriseUrl ?? credential.enterpriseUrl,
		apiEndpoint: refreshed.apiEndpoint ?? credential.apiEndpoint,
		...mergeRefreshedOrganizationScope(credential, refreshed),
	};
}

/** Dependencies for usage fetching and cache coordination; supplied by AuthStorage. */
export interface UsageServiceDeps {
	store: AuthCredentialStore;
	pool: CredentialPool;
	overrides: KeyOverrides;
	refresher: OAuthRefresher;
	cache: UsageCache;
	blocks: CredentialBlocks;
	affinity: SessionAffinity;
	strategies: RankingStrategyResolver;
	usageProviders: (provider: Provider) => UsageProvider | undefined;
	fetch: typeof fetch;
	requestTimeoutMs: number;
	logger: UsageLogger;
}

type UsageReportsOptions = {
	baseUrlResolver?: (provider: Provider) => string | undefined;
	signal?: AbortSignal;
};

/** Usage reports: per-credential cached fetches, aggregate reports, header ingestion, history. */
export class UsageService implements UsageApi {
	#deps: UsageServiceDeps;
	/** Runtime extension providers take precedence over the configured/default resolver. */
	#runtimeUsageProviderOverrides: Map<Provider, { provider: UsageProvider; apiKey?: string }> = new Map();
	/** One probe per credential report key, tagged with the refresh epoch it can answer. */
	#usageRequestInFlight: Map<string, { refreshEpoch: number; promise: Promise<UsageReport | null> }> = new Map();
	#usageHeaderIngestAt: Map<string, number> = new Map();
	#usageReportsInFlight: Map<string, Promise<UsageReport[] | null>> = new Map();
	/** Last explicit-billing observation per exact key. Only the exact refresh path writes it. */
	#exactUsageCache: Map<string, RoutingObservation> = new Map();
	#exactUsageInFlight: Map<string, ExactUsageFlight> = new Map();
	readonly fetch: typeof fetch;
	readonly logger: UsageLogger;
	readonly requestTimeoutMs: number;

	constructor(deps: UsageServiceDeps) {
		this.#deps = deps;
		this.fetch = deps.fetch;
		this.logger = deps.logger;
		this.requestTimeoutMs = deps.requestTimeoutMs;
	}

	/** Whether OAuth usage can be fetched via a provider or the store hook. */
	canFetchOAuthUsage(provider: Provider): boolean {
		return this.providerFor(provider) !== undefined || this.#deps.store.getUsageReport !== undefined;
	}

	/**
	 * The {@link UsageProvider} registered for `provider`, or undefined when the
	 * provider has no usage endpoint at all. Lets callers tell "a credential we
	 * could have fetched usage for but didn't" apart from "a provider with no
	 * usage concept" (web-search keys, local/keyless servers, inference
	 * providers without a usage API) — the latter never warrants a usage row.
	 */
	providerFor(provider: Provider): UsageProvider | undefined {
		return this.#runtimeUsageProviderOverrides.get(provider)?.provider ?? this.#deps.usageProviders(provider);
	}

	/**
	 * Install a runtime usage provider override (not persisted to disk).
	 *
	 * Runtime overrides are checked before the configured resolver, including its
	 * built-in fallback. Removing the override restores that resolver unchanged.
	 */
	setProvider(provider: Provider, usageProvider: UsageProvider, apiKey?: string): void {
		this.#runtimeUsageProviderOverrides.set(provider, {
			provider: usageProvider,
			apiKey,
		});
		this.#deps.cache.invalidateForProvider(provider);
	}
	/** Carry runtime usage provider overrides over from the service this one replaces (store swap). */
	adoptRuntimeProviders(previous: UsageService): void {
		this.#runtimeUsageProviderOverrides = previous.#runtimeUsageProviderOverrides;
	}

	/** Remove a runtime usage provider override and restore configured/default resolution. */
	removeProvider(provider: Provider): void {
		if (!this.#runtimeUsageProviderOverrides.has(provider)) return;
		this.#deps.cache.invalidateForProvider(provider);
		this.#runtimeUsageProviderOverrides.delete(provider);
	}

	/** Preserve the persisted OAuth row's login anchor and subtype metadata on usage-path refresh. */
	persistRefreshedCredential(
		provider: Provider,
		previous: UsageCredential,
		next: UsageCredential,
		credentialId = this.#deps.pool.findIdForUsageCredential(provider, previous),
	): void {
		if (credentialId === undefined) return;
		const entry = this.#deps.pool.entries(provider).find(candidate => candidate.id === credentialId);
		if (entry?.credential.type !== "oauth") return;
		this.#deps.pool.replaceById(provider, credentialId, {
			...entry.credential,
			access: next.accessToken ?? entry.credential.access,
			refresh: next.refreshToken ?? entry.credential.refresh,
			expires: next.expiresAt ?? entry.credential.expires,
			accountId: next.accountId ?? entry.credential.accountId,
			projectId: next.projectId ?? entry.credential.projectId,
			email: next.email ?? entry.credential.email,
			enterpriseUrl: next.enterpriseUrl ?? entry.credential.enterpriseUrl,
			apiEndpoint: next.apiEndpoint ?? entry.credential.apiEndpoint,
			orgId: next.orgId,
			orgName: next.orgName,
			region: next.region,
			inferenceRegion: next.inferenceRegion,
			activeOrganizationId: next.activeOrganizationId,
		});
	}

	/** Probe a provider endpoint, refreshing near-expiry OAuth tokens when possible. */
	async #fetchUsageUncached(request: UsageRequestDescriptor, timeoutMs?: number): Promise<UsageReport | null> {
		const providerImpl = this.providerFor(request.provider);
		if (!providerImpl) return null;

		const timeoutSignal =
			typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
				? AbortSignal.timeout(timeoutMs)
				: undefined;
		let params: UsageFetchParams = {
			...request,
			accountKey: usageCacheIdentity(request.credential),
			signal: timeoutSignal,
		};

		if (
			request.credential.type === "oauth" &&
			request.credential.expiresAt !== undefined &&
			Date.now() + OAUTH_REFRESH_SKEW_MS >= request.credential.expiresAt
		) {
			const refreshableCredential = buildRefreshableOauthCredential(request.credential);
			if (refreshableCredential) {
				try {
					const refreshableCredentialId = this.#deps.pool.findIdForUsageCredential(
						request.provider,
						request.credential,
					);
					const refreshed = await this.#deps.refresher.refresh(
						request.provider,
						refreshableCredential,
						refreshableCredentialId,
						timeoutSignal,
					);
					const refreshedCredential = mergeRefreshedUsageCredential(request.credential, refreshed);
					this.persistRefreshedCredential(
						request.provider,
						request.credential,
						refreshedCredential,
						refreshableCredentialId,
					);
					params = {
						...request,
						credential: refreshedCredential,
						accountKey: usageCacheIdentity(refreshedCredential),
						signal: timeoutSignal,
					};
				} catch (error) {
					const errorMsg = String(error);
					if (request.credential.expiresAt <= Date.now() && AIError.isDefinitiveOAuthFailure(errorMsg)) {
						// The current access token is unusable, so don't replay an
						// old usage report after its rotating refresh token is revoked.
						// This changes cache state only; usage polling remains
						// non-authoritative about the credential lifecycle.
						this.#deps.cache.set(this.#deps.cache.reportKey(request), {
							value: null,
							expiresAt: 0,
						});
					}
					// Usage polling is advisory. A refresh can fail while the current
					// access token remains valid inside the refresh skew, so probe with
					// that token and never mutate credential state from this path.
					this.logger?.debug("Usage credential refresh failed, using original credential", {
						provider: request.provider,
						error: errorMsg,
					});
				}
			}
		}

		if (providerImpl.supports && !providerImpl.supports(params)) return null;

		try {
			const previousReport = this.#deps.cache.getStale<UsageReport | null>(
				this.#deps.cache.reportKey(request),
			)?.value;
			const report = await providerImpl.fetchUsage(params, {
				fetch: this.fetch,
				logger: this.logger,
				...(previousReport ? { previousReport } : {}),
			});
			// Attribute the report to the credential's organization. The orgId and
			// orgName fallbacks apply independently: Claude's usage endpoint stamps
			// orgId from the `anthropic-organization-id` response header but never
			// carries a display name, so the stored name must still be attached.
			// Never attach the stored name over a DIFFERENT org's report.
			if (report && params.credential.orgId !== undefined) {
				const metadata = report.metadata ?? {};
				const sameOrg = metadata.orgId === undefined || metadata.orgId === params.credential.orgId;
				const needsOrgId = metadata.orgId === undefined;
				const needsOrgName = sameOrg && params.credential.orgName !== undefined && metadata.orgName === undefined;
				if (needsOrgId || needsOrgName) {
					report.metadata = {
						...metadata,
						...(needsOrgId ? { orgId: params.credential.orgId } : {}),
						...(needsOrgName ? { orgName: params.credential.orgName } : {}),
					};
				}
			}
			return report;
		} catch (error) {
			if (error instanceof AIError.ProviderHttpError && (error.status === 401 || error.status === 403)) {
				// Definitive auth failure (revoked key, lapsed subscription): purge
				// the last-good report so #fetchUsageCached's failure branch can't
				// keep rendering and ranking from stale quota the way it does for
				// transient failures. Mirrors the definitive-OAuth-refresh path.
				this.#deps.cache.set(this.#deps.cache.reportKey(request), {
					value: null,
					expiresAt: 0,
				});
			}
			logger.debug("AuthStorage usage fetch failed", {
				provider: request.provider,
				error: String(error),
			});
			return null;
		}
	}

	/** Cache a credential report with jitter and failure cooldown. */
	async #fetchUsageCached(
		request: UsageRequestDescriptor,
		options: { timeoutMs?: number } = {},
	): Promise<UsageReport | null> {
		const timeoutMs = options.timeoutMs;
		const cacheKey = this.#deps.cache.reportKey(request);
		const failureKey = this.#deps.cache.failureKey(cacheKey);
		const now = Date.now();
		const cached = this.#deps.cache.get<UsageReport | null>(cacheKey);
		// Fresh cache hit: return whatever's there (success or null fallback).
		if (cached && cached.expiresAt > now) {
			return cached.value;
		}

		const failure = this.#deps.cache.get<number | null>(failureKey);
		if (failure && failure.expiresAt > now) {
			return this.#deps.cache.getStale<UsageReport | null>(cacheKey)?.value ?? null;
		}

		// Invalidation must not fork an already-running credential probe. Share it;
		// only a refresh that postdates its start (user refresh, confirmed reset)
		// earns one successor probe.
		const inFlight = this.#usageRequestInFlight.get(cacheKey);
		if (inFlight) {
			const report = await inFlight.promise;
			return inFlight.refreshEpoch === this.#deps.cache.refreshEpoch(request.provider)
				? report
				: this.#fetchUsageCached(request, options);
		}
		const usageCacheEpoch = this.#deps.cache.epoch;
		const refreshEpoch = this.#deps.cache.refreshEpoch(request.provider);
		const recoveryEpoch = this.#deps.cache.recoveryEpoch(request.provider);
		const promise = (async () => {
			const report = await this.#fetchUsageUncached(request, timeoutMs);
			// Block marks bump the generation too: a report racing a fresh 429 may
			// predate it, so it answers this probe but is neither cached nor used
			// to heal blocks.
			const invalidated = usageCacheEpoch !== this.#deps.cache.epoch;
			if (report !== null) {
				if (invalidated) return report;
				this.#deps.blocks.reconcileRequest(request, report);
				if (this.#deps.cache.getStale(failureKey)) this.#deps.cache.set(failureKey, { value: null, expiresAt: 0 });
				const ttlJitter = USAGE_REPORT_TTL_MS * (Math.random() * 0.5 - 0.25);
				// Success: stagger per-credential cache expiry so all accounts don't
				// refresh in the same window — Anthropic / OpenAI rate-limit `/usage`
				// per source IP regardless of account, and synchronized 5-credential
				// fan-out trips 429s every cycle. With ±25% jitter on TTL the refresh
				// times decorrelate within a few cycles.
				this.#deps.cache.set(cacheKey, {
					value: report,
					expiresAt: Date.now() + USAGE_REPORT_TTL_MS + ttlJitter,
				});
				this.#recordUsageHistory(request, report);
				return report;
			}
			// Failure: apply a short jittered cool-down so the credential doesn't
			// re-hit the endpoint on every poll. Most providers serve the last good
			// value through transient failures. Session-cookie providers can opt out
			// so an expired login does not display stale quota indefinitely.
			const providerImpl = this.providerFor(request.provider);
			const retainLastGood = !invalidated && providerImpl?.retainLastGoodOnFailure !== false;
			const lastGood = retainLastGood
				? (this.#deps.cache.getStale<UsageReport | null>(cacheKey)?.value ?? null)
				: null;
			const previousStreak = this.#deps.cache.getStale<number | null>(failureKey)?.value;
			const streak = typeof previousStreak === "number" ? previousStreak : 0;
			const failureBackoffMs = failureCooldownMs(providerImpl?.failureBackoffMs ?? USAGE_FAILURE_BACKOFF_MS, streak);
			const backoffJitter = failureBackoffMs * (Math.random() * 0.5 - 0.25);
			const coolDown = Date.now() + failureBackoffMs + backoffJitter;
			// Dropping snapshots is not recovery from a failed endpoint. Persist its
			// cooldown even if a manual refresh or block update raced this probe.
			// A confirmed reset is the exception: the old failure cannot suppress
			// the first post-reset probe.
			if (recoveryEpoch === this.#deps.cache.recoveryEpoch(request.provider)) {
				this.#deps.cache.set(failureKey, { value: streak + 1, expiresAt: coolDown });
			}
			if (!invalidated) this.#deps.cache.set(cacheKey, { value: lastGood, expiresAt: coolDown });
			return lastGood;
		})().finally(() => {
			this.#usageRequestInFlight.delete(cacheKey);
		});

		this.#usageRequestInFlight.set(cacheKey, { refreshEpoch, promise });
		const report = await promise;
		return refreshEpoch === this.#deps.cache.refreshEpoch(request.provider)
			? report
			: this.#fetchUsageCached(request, options);
	}

	/**
	 * Append a freshly fetched report to durable usage history (when the store
	 * supports it). The usage cache is latest-snapshot-only — these rows are
	 * the only place limit utilization is kept over time.
	 */
	#recordUsageHistory(request: UsageRequestDescriptor, report: UsageReport): void {
		const record = this.#deps.store.recordUsageSnapshots;
		if (!record || report.limits.length === 0) return;
		const recordedAt = Number.isFinite(report.fetchedAt) && report.fetchedAt > 0 ? report.fetchedAt : Date.now();
		const accountKey = usageCacheIdentity(request.credential);
		const metadata = report.metadata ?? {};
		const metaEmail = typeof metadata.email === "string" ? metadata.email : undefined;
		const metaAccountId = typeof metadata.accountId === "string" ? metadata.accountId : undefined;
		const entries: UsageHistoryEntry[] = report.limits.map(limit => ({
			recordedAt,
			provider: request.provider,
			accountKey,
			email: request.credential.email ?? metaEmail,
			accountId: request.credential.accountId ?? limit.scope.accountId ?? metaAccountId,
			limitId: limit.id,
			label: limit.label,
			windowLabel: limit.window?.label ?? limit.scope.windowId,
			usedFraction: resolveUsedFraction(limit),
			status: limit.status,
			resetsAt: limit.window?.resetsAt,
		}));
		try {
			record.call(this.#deps.store, entries);
		} catch (error) {
			this.logger?.debug("usage history record failed", {
				provider: request.provider,
				error: String(error),
			});
		}
	}

	/**
	 * Recorded usage-limit snapshots, oldest first. Empty when the underlying
	 * store has no durable history (e.g. a broker-backed remote store).
	 */
	history(query?: UsageHistoryQuery): UsageHistoryEntry[] {
		return this.#deps.store.listUsageHistory?.(query) ?? [];
	}

	/**
	 * Forward one completed request's usage to the store's observer hook.
	 * Broker-backed stores batch these into per-install reports so the broker
	 * can track actual token burn per client; local stores have no hook and
	 * the call is a no-op.
	 */
	observe(entry: ObservedUsageInput): void {
		const record = this.#deps.store.recordObservedUsage;
		if (!record) return;
		try {
			record.call(
				this.#deps.store,
				[
					{
						at: entry.at ?? Date.now(),
						provider: entry.provider,
						model: entry.model,
						requests: 1,
						inputTokens: entry.usage.input,
						outputTokens: entry.usage.output,
						cacheReadTokens: entry.usage.cacheRead,
						cacheWriteTokens: entry.usage.cacheWrite,
						costUsd: Number.isFinite(entry.costUsd) ? (entry.costUsd ?? 0) : 0,
					},
				],
				entry.client,
			);
		} catch (error) {
			this.logger?.debug("observed usage record failed", {
				provider: entry.provider,
				error: String(error),
			});
		}
	}

	/** Broker host: persist one client's observed-usage report (per-install token burn). */
	recordClient(report: ClientUsageReport): boolean {
		const record = this.#deps.store.recordClientUsage;
		if (!record) return false;
		record.call(this.#deps.store, report);
		return true;
	}

	/** Broker host: aggregate recorded per-client usage since `sinceMs`. */
	clientSummary(sinceMs: number): ClientUsageSummary {
		return this.#deps.store.getClientUsageSummary?.(sinceMs) ?? { clients: [] };
	}

	/** Merge rate-limit headers into the latest account report. */
	ingestHeaders(
		provider: Provider,
		headers: Record<string, string>,
		options?: { sessionId?: string; baseUrl?: string; responseStatus?: number },
	): boolean {
		const parseHeaders = this.providerFor(provider)?.parseRateLimitHeaders;
		if (!parseHeaders) return false;

		const credential = this.#deps.affinity.activeOAuth(provider, options?.sessionId);
		if (!credential) return false;

		const cacheKey = this.#deps.cache.reportKey(oauthUsageRequest(provider, credential, options?.baseUrl));
		const now = Date.now();
		const parsedReport = parseHeaders(headers, now, { responseStatus: options?.responseStatus });
		if (!parsedReport) return false;
		// Throttled to one ingest per interval — except when a window reads
		// exhausted: persist that snapshot immediately. A full-backed cache can
		// then block the next getApiKey; a cold header-only snapshot first probes
		// the usage endpoint.
		const exhausted = parsedReport.limits.some(limit => isUsageLimitExhausted(limit));
		const last = this.#usageHeaderIngestAt.get(cacheKey);
		if (!exhausted && last !== undefined && now - last < USAGE_HEADER_INGEST_INTERVAL_MS) return false;
		const metadata: Record<string, unknown> = { ...parsedReport.metadata };
		if (credential.accountId && metadata.accountId === undefined) metadata.accountId = credential.accountId;
		if (credential.email && metadata.email === undefined) metadata.email = credential.email;
		if (credential.projectId && metadata.projectId === undefined) metadata.projectId = credential.projectId;
		if (credential.orgId && metadata.orgId === undefined) metadata.orgId = credential.orgId;
		if (credential.orgName && metadata.orgName === undefined) metadata.orgName = credential.orgName;
		const report: UsageReport = { ...parsedReport, metadata };

		const storeIngest = this.#deps.store.ingestUsageReport?.bind(this.#deps.store);
		if (storeIngest) {
			const ingested = storeIngest(provider, credential, report);
			if (ingested) this.#usageHeaderIngestAt.set(cacheKey, now);
			return ingested;
		}

		if (this.#deps.store.fetchUsageReports) return false;
		const priorEntry = this.#deps.cache.getStale<UsageReport | null>(cacheKey);
		const prior = priorEntry?.value;
		let merged = report;
		if (prior && Array.isArray(prior.limits)) {
			const headerLimitsById = new Map(report.limits.map(limit => [limit.id, limit]));
			const limits: UsageLimit[] = [];
			for (const limit of prior.limits) {
				const replacement = headerLimitsById.get(limit.id);
				if (replacement) {
					limits.push(replacement);
					headerLimitsById.delete(limit.id);
				} else {
					limits.push(limit);
				}
			}
			for (const limit of headerLimitsById.values()) {
				limits.push(limit);
			}
			// Headers replace same-id windows but never renew billing: the prior
			// observation keeps its original full-response timestamp.
			const routingObservation = mergeHeaderRoutingObservation(
				readRoutingObservation(prior),
				readRoutingObservation(report),
			);
			merged = {
				...prior,
				fetchedAt: now,
				limits,
				metadata: {
					...report.metadata,
					...prior.metadata,
					...(routingObservation ? { routingObservation } : {}),
					source: prior.metadata?.source,
					headersUpdatedAt: now,
				},
			};
		}

		// Header ingestion merges values but never extends a cache entry's lifetime.
		// Preserve the existing expiry (including active failure cooldowns) so full
		// reports refetch on their original 5-minute schedule and full-payload-only
		// rows such as extra usage stay current; headers only refresh window rows
		// between fetches. A newly minted header-only report is durable but stale.
		const expiresAt = Math.max(priorEntry?.expiresAt ?? now - 1, now - 1);
		this.#deps.cache.set(cacheKey, { value: merged, expiresAt });
		this.#usageHeaderIngestAt.set(cacheKey, now);
		return true;
	}

	/** Collect resolved account requests, restricted to runtime providers when the store owns aggregate reports. */
	async #collectUsageRequests(
		options?: UsageReportsOptions,
		providerFilter?: ReadonlySet<Provider>,
	): Promise<UsageRequestDescriptor[]> {
		const requests: UsageRequestDescriptor[] = [];
		const providers =
			providerFilter ??
			new Set<string>([
				...this.#deps.pool.providers(),
				...this.#runtimeUsageProviderOverrides.keys(),
				...DEFAULT_USAGE_PROVIDERS.map(provider => provider.id),
			]);

		for (const providerId of providers) {
			const provider = providerId as Provider;
			const providerImpl = this.providerFor(provider);
			if (!providerImpl) continue;
			const baseUrl = options?.baseUrlResolver?.(provider);
			let entries = this.#deps.pool.entries(providerId);
			if (entries.length > 0) {
				const dedupedEntries = await this.#deps.pool.pruneDuplicates(providerId, entries);
				if (dedupedEntries.length !== entries.length) {
					this.#deps.pool.replace(providerId, dedupedEntries);
				}
				entries = dedupedEntries;
			}

			// A declared OAuth bearer env list means usage probes must ignore stored
			// API keys and borrowed API-key env aliases. Even when an API-key row
			// exists, fall back to the provider's own OAuth env bearer.
			const oauthTokenEnv = authPolicyFor(providerId)?.oauthTokenEnv;
			if (oauthTokenEnv) {
				let hasUsableStoredOAuthCredential = false;
				for (const entry of entries) {
					if (entry.credential.type !== "oauth") continue;
					const request = oauthUsageRequest(provider, entry.credential, baseUrl);
					if (providerImpl.supports && !providerImpl.supports(request)) continue;
					requests.push(request);
					hasUsableStoredOAuthCredential = true;
				}
				const oauthToken = $pickenv(...oauthTokenEnv);
				if (!hasUsableStoredOAuthCredential && oauthToken) {
					const request = usageRequest(provider, { type: "oauth", accessToken: oauthToken }, baseUrl);
					if (!providerImpl.supports || providerImpl.supports(request)) requests.push(request);
				}
				continue;
			}

			if (entries.length === 0) {
				const runtimeKey = this.#deps.overrides.runtimeKey(providerId);
				const extensionUsageKeyConfig = this.#runtimeUsageProviderOverrides.get(provider)?.apiKey,
					extensionUsageKey = extensionUsageKeyConfig
						? await this.#deps.overrides.resolve(extensionUsageKeyConfig)
						: undefined,
					envKey = getEnvApiKey(providerId);
				const apiKey = runtimeKey ?? extensionUsageKey ?? envKey;
				if (!apiKey) continue;
				const request = usageRequest(provider, { type: "api_key", apiKey }, baseUrl);
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
				continue;
			}

			for (const entry of entries) {
				const credential = entry.credential;
				let request: UsageRequestDescriptor;
				if (credential.type === "api_key") {
					// Stored keys may be references (env var name, "!command") —
					// resolve to the actual secret before it reaches a provider
					// fetcher's Authorization header. Unresolvable references are
					// skipped: probing with the literal reference string would
					// 401 and flag a working credential as bad.
					const apiKey = await this.#deps.overrides.resolve(credential.key);
					if (!apiKey) continue;
					request = usageRequest(provider, { type: "api_key", apiKey }, baseUrl);
				} else {
					request = oauthUsageRequest(provider, credential, baseUrl);
				}
				if (providerImpl.supports && !providerImpl.supports(request)) continue;
				requests.push(request);
			}
		}

		return requests;
	}

	/**
	 * Already-loaded usage for one native Anthropic row, bound to its source and row id.
	 * Reads only the local cache or the store's own overlay: no fetch, no token refresh,
	 * no sibling lookup. Null for a missing hook, row, source namespace, or any
	 * identity/endpoint mismatch.
	 */
	peekByCredentialId(request: UsageCachePeekRequest): Readonly<UsageReport> | null {
		if (request.provider !== "anthropic") return null;
		const source = this.#deps.pool.routingIdentities({ provider: "anthropic" }).source;
		if (source.status !== "supported" || !isStoreNamespace(source.storeNamespace)) return null;
		const entry = this.#deps.pool.entries("anthropic").find(candidate => candidate.id === request.credentialId);
		const credential = entry?.credential;
		if (credential?.type !== "oauth") return null;
		// Reports polled without a resolver sit under the default-base-url key; the endpoint
		// check below still pins whichever slot answers to the requested base URL.
		const report = this.#deps.store.peekUsageByCredentialId
			? this.#deps.store.peekUsageByCredentialId(request)
			: [request.baseUrl, undefined]
					.map(
						baseUrl =>
							this.#deps.cache.getStale<UsageReport | null>(
								this.#deps.cache.reportKey(oauthUsageRequest("anthropic", credential, baseUrl)),
							)?.value,
					)
					.find(candidate => readRoutingObservation(candidate) !== null);
		const observation = readRoutingObservation(report);
		if (!report || !observation) return null;
		if (observation.endpoint !== null && observation.endpoint !== `${claudeOAuthBaseUrl(request.baseUrl)}/usage`) {
			return null;
		}
		if (
			observation.nativeRowId !== null &&
			(observation.nativeRowId !== request.credentialId || observation.storeNamespace !== source.storeNamespace)
		) {
			return null;
		}
		const { accountId, orgId } = credential;
		if (
			(observation.accountId !== null && accountId !== undefined && observation.accountId !== accountId) ||
			(observation.organizationId !== null && orgId !== undefined && observation.organizationId !== orgId)
		) {
			return null;
		}
		const bound: RoutingObservation = {
			...observation,
			storeNamespace: source.storeNamespace,
			nativeRowId: request.credentialId,
		};
		return { ...report, metadata: { ...report.metadata, routingObservation: bound } };
	}

	/**
	 * Admission-only exact-row refresh. Resolves the one durable row, then either queries the
	 * provider locally or asks the broker owner; both coalesce per namespace+provider+row+model+base URL.
	 * Every caller's cancellation is independent: the shared read aborts only when its last waiter leaves.
	 */
	async refreshRoutingObservation(request: RoutingExactUsageRequest): Promise<RoutingExactUsageResult> {
		const { accountRef, nowMs } = request;
		const unknown = (code: RoutingExactUsageUnknownCode): RoutingExactUsageResult => ({
			kind: "unknown",
			accountRef,
			code,
		});
		const rejected = exactUsageRequestRejection(request);
		if (rejected) return unknown(rejected);
		if (request.signal?.aborted) return unknown("cancelled");

		const source = this.#deps.pool.routingIdentities({ provider: "anthropic" }).source;
		if (source.status !== "supported" || source.storeNamespace !== accountRef.storeNamespace) {
			return unknown("source_changed");
		}
		const row = this.#deps.pool.entries("anthropic").find(candidate => candidate.id === accountRef.nativeRowId);
		const stored = row?.credential;
		if (stored?.type !== "oauth") return unknown("row_unavailable");

		const key = [
			accountRef.storeNamespace,
			request.provider,
			accountRef.nativeRowId,
			request.modelId ?? "",
			claudeOAuthBaseUrl(request.baseUrl),
		].join("\0");
		const done = (observation: RoutingObservation): RoutingExactUsageResult => ({
			kind: "observed",
			accountRef,
			modelId: request.modelId,
			baseUrl: request.baseUrl,
			observation: { ...observation, billing: currentIncludedBilling(observation.billing, nowMs) },
		});

		const cached = this.#exactUsageCache.get(key);
		if (cached) {
			if (
				!request.forceRefresh &&
				currentIncludedBilling(cached.billing, nowMs).state !== "unknown" &&
				observationBelongsToRow(cached, accountRef, request.baseUrl, stored)
			) {
				return done(cached);
			}
			this.#exactUsageCache.delete(key);
		}

		let flight = this.#exactUsageInFlight.get(key);
		if (!flight) {
			const controller = new AbortController();
			const fresh: ExactUsageFlight = {
				controller,
				waiters: 0,
				promise: this.#readExactObservation(request, stored, controller.signal).finally(() => {
					if (this.#exactUsageInFlight.get(key) === fresh) this.#exactUsageInFlight.delete(key);
				}),
			};
			this.#exactUsageInFlight.set(key, fresh);
			flight = fresh;
		}
		const joined = flight;
		joined.waiters += 1;
		let outcome: RoutingObservation | RoutingExactUsageUnknownCode;
		try {
			outcome = await raceSignal(joined.promise, request.signal, "exact usage refresh aborted");
		} catch (error) {
			if (request.signal?.aborted) return unknown("cancelled");
			this.logger?.debug("Exact routing refresh failed", { error: String(error) });
			return unknown("unavailable");
		} finally {
			joined.waiters -= 1;
			// Last waiter gone while the read is still pending: drop it first so a late caller starts a
			// fresh read instead of joining an aborting one, then abort the shared request.
			if (joined.waiters === 0 && this.#exactUsageInFlight.get(key) === joined) {
				this.#exactUsageInFlight.delete(key);
				joined.controller.abort();
			}
		}
		if (typeof outcome === "string") return unknown(outcome);
		if (!observationBelongsToRow(outcome, accountRef, request.baseUrl, stored)) return unknown("identity_mismatch");
		// ponytail: failures are not negatively cached; the admission driver owns retry pacing.
		if (outcome.billing.state !== "unknown") this.#exactUsageCache.set(key, outcome);
		return done(outcome);
	}

	async #readExactObservation(
		request: RoutingExactUsageRequest,
		stored: OAuthCredential,
		signal: AbortSignal,
	): Promise<RoutingObservation | RoutingExactUsageUnknownCode> {
		const { accountRef } = request;
		const store = this.#deps.store;
		if (store.refreshExactUsage) {
			return store.refreshExactUsage({
				accountRef,
				provider: request.provider,
				modelId: request.modelId,
				baseUrl: request.baseUrl,
				nowMs: request.nowMs,
				signal,
			});
		}
		// A store that owns credentials elsewhere but cannot answer exactly must not be served from sentinel rows.
		if (store.getUsageReport || store.fetchUsageReports) return "unsupported";
		// Every process on this machine shares one read per row and one failure cool-down. `/usage` is
		// throttled per source IP, so per-process reads from many agents trip 429s, and re-polling
		// during a 429 keeps it tripped. Freshness is still judged only by the billing's own observedAt.
		const sharedKey = `routing-exact:${accountRef.storeNamespace}:${accountRef.nativeRowId}:${claudeOAuthBaseUrl(request.baseUrl)}`;
		const failureKey = this.#deps.cache.failureKey(sharedKey);
		if (!request.forceRefresh) {
			const shared = this.#deps.cache.getStale<RoutingObservation>(sharedKey)?.value;
			if (
				shared &&
				currentIncludedBilling(shared.billing, request.nowMs).state !== "unknown" &&
				observationBelongsToRow(shared, accountRef, request.baseUrl, stored)
			) {
				return shared;
			}
		}
		const failure = this.#deps.cache.getStale<{ until: number; streak: number } | null>(failureKey)?.value;
		if (failure && request.nowMs < failure.until) return "unavailable";
		const observation = await this.queryRoutingObservation({
			binding: {
				storeNamespace: accountRef.storeNamespace,
				nativeRowId: accountRef.nativeRowId,
				accountId: stored.accountId ?? null,
				organizationId: stored.orgId ?? null,
			},
			credential: buildUsageCredential(stored),
			modelId: request.modelId,
			baseUrl: request.baseUrl,
			signal,
			nowMs: request.nowMs,
		});
		if (signal.aborted) return "unavailable";
		if (!observation) {
			// ponytail: escalating cool-down stands in for retry-after, which fetchUsage does not surface.
			const streak = failure?.streak ?? 0;
			const backoffMs = failureCooldownMs(
				this.providerFor("anthropic")?.failureBackoffMs ?? USAGE_FAILURE_BACKOFF_MS,
				streak,
			);
			this.#deps.cache.set(failureKey, {
				value: { until: request.nowMs + backoffMs, streak: streak + 1 },
				expiresAt: Date.now() + backoffMs,
			});
			return "unavailable";
		}
		if (failure) this.#deps.cache.set(failureKey, { value: null, expiresAt: 0 });
		if (observation.billing.state !== "unknown") {
			this.#deps.cache.set(sharedKey, { value: observation, expiresAt: Date.now() + ROUTING_BILLING_MAX_AGE_MS });
		}
		return observation;
	}

	/**
	 * Read one exact row's billing and window evidence from a fresh full usage response.
	 * Uses the single caller-selected credential: no sibling lookup, no cache write, no
	 * token refresh. Only the provider parser sets the observation time (`nowMs`).
	 */
	async queryRoutingObservation(args: {
		binding: RoutingBinding;
		credential: UsageCredential;
		modelId: string | null;
		baseUrl: string;
		signal?: AbortSignal;
		nowMs: number;
	}): Promise<RoutingObservation | null> {
		const providerImpl = this.providerFor("anthropic");
		if (!providerImpl) return null;
		const params: UsageFetchParams = {
			provider: "anthropic",
			credential: args.credential,
			baseUrl: args.baseUrl,
			signal: args.signal,
			nowMs: args.nowMs,
		};
		if (providerImpl.supports && !providerImpl.supports(params)) return null;
		let report: UsageReport | null;
		try {
			report = await providerImpl.fetchUsage(params, { fetch: this.fetch, logger: this.logger });
		} catch (error) {
			this.logger?.debug("Routing observation fetch failed", { error: String(error) });
			return null;
		}
		const observation = readRoutingObservation(report);
		if (!observation) return null;
		const { binding } = args;
		const mismatched =
			(observation.accountId !== null &&
				binding.accountId !== null &&
				observation.accountId !== binding.accountId) ||
			(observation.organizationId !== null &&
				binding.organizationId !== null &&
				observation.organizationId !== binding.organizationId);
		return {
			...observation,
			storeNamespace: binding.storeNamespace,
			nativeRowId: binding.nativeRowId,
			billing: mismatched ? unknownBilling("identity_mismatch") : observation.billing,
		};
	}

	/** Fetch the best available report for one stored credential. */
	async report(
		provider: Provider,
		credential: AuthCredential,
		options?: { baseUrl?: string; timeoutMs?: number; signal?: AbortSignal },
	): Promise<UsageReport | null> {
		// Store-level hook (e.g. `RemoteAuthCredentialStore`) is authoritative
		// when present for OAuth: the broker already aggregates usage from a
		// less-throttled IP, and falling back to the local per-credential fetch
		// would defeat the point of routing through it. API-key credentials do
		// not have a broker per-credential hook, so they use the normal cached
		// provider fetch path.
		if (credential.type === "oauth") {
			const storeHook = this.#deps.store.getUsageReport?.bind(this.#deps.store);
			if (storeHook) {
				const report = await storeHook(provider, credential, options?.signal);
				if (report) {
					this.#deps.blocks.reconcileRequest(oauthUsageRequest(provider, credential, options?.baseUrl), report);
				}
				return report;
			}
		}
		const usageCredential = buildUsageCredential(credential);
		if (credential.type === "api_key") {
			const resolvedApiKey = await this.#deps.overrides.resolve(credential.key);
			if (!resolvedApiKey) return null;
			usageCredential.apiKey = resolvedApiKey;
		}
		return this.#fetchUsageCached(usageRequest(provider, usageCredential, options?.baseUrl), {
			timeoutMs: options?.timeoutMs ?? this.requestTimeoutMs,
		});
	}

	/**
	 * Return model ids whose live reports map to a quantitative usage scope.
	 * Provider strategies supply model/tier mapping when available; otherwise
	 * only explicitly matching model ids and account-wide shared limits count.
	 * Label-only or ambiguous tier limits are excluded rather than guessed.
	 */
	reportingModelIds(provider: Provider, modelIds: readonly string[], reports: readonly UsageReport[]): string[] {
		const strategy = this.#deps.strategies(provider);
		const providerReports = reports.filter(report => report.provider === provider);
		if (providerReports.length === 0) return [];
		const seen = new Set<string>();
		const reporting: string[] = [];
		for (const modelId of modelIds) {
			if (seen.has(modelId)) continue;
			seen.add(modelId);
			const context: CredentialRankingContext = { modelId };
			const hasUsage = providerReports.some(report => {
				const limits = strategy
					? scopedUsageLimits(strategy, report, context)
					: report.limits.filter(limit => limit.scope.shared === true || limit.scope.modelId === modelId);
				return limits.some(limit => isUsageLimitExhausted(limit) || resolveUsedFraction(limit) !== undefined);
			});
			if (hasUsage) reporting.push(modelId);
		}
		return reporting;
	}

	/**
	 * Fetch every requested report, keeping normal polls parallel while a
	 * manually invalidated provider probes accounts one at a time.
	 */
	#fetchUsageRequests(
		requests: readonly UsageRequestDescriptor[],
		serializedProviders: ReadonlySet<Provider>,
	): Promise<Array<UsageReport | null>> {
		const tails = new Map<Provider, Promise<void>>();
		return Promise.all(
			requests.map(request => {
				if (!serializedProviders.has(request.provider)) {
					return this.#fetchUsageCached(request, {
						timeoutMs: this.requestTimeoutMs,
					});
				}
				const tail = tails.get(request.provider) ?? Promise.resolve();
				const current = tail.then(() =>
					this.#fetchUsageCached(request, {
						timeoutMs: this.requestTimeoutMs,
					}),
				);
				tails.set(
					request.provider,
					current.then(
						() => undefined,
						() => undefined,
					),
				);
				return current;
			}),
		);
	}

	/** Fetch all providers’ current usage reports, sharing concurrent polls. */
	async reports(options?: UsageReportsOptions): Promise<UsageReport[] | null> {
		// The broker owns its providers' reports; runtime providers registered
		// only in this process still need local per-credential probes.
		const storeOverride = this.#deps.store.fetchUsageReports?.bind(this.#deps.store);
		if (storeOverride) {
			// Reuse the in-flight map so concurrent callers (widget poll + format
			// dispatch + credential selection) coalesce into one upstream call.
			// Each caller's `signal` only cancels THAT caller's await; the
			// shared upstream fetch runs to completion so peers aren't punished.
			const overrideKey = `__override__\0${this.#deps.cache.epoch}`;
			let shared = this.#usageReportsInFlight.get(overrideKey);
			if (!shared) {
				// Don't forward the caller signal into the shared fetch — first caller's
				// abort would otherwise cancel the upstream for every peer.
				shared = storeOverride().finally(() => {
					this.#usageReportsInFlight.delete(overrideKey);
				});
				this.#usageReportsInFlight.set(overrideKey, shared);
			}
			const reports = await raceSignal(shared, options?.signal, "usage fetch aborted");
			if (reports) this.#deps.blocks.reconcileReports(reports);
			if (!reports || this.#runtimeUsageProviderOverrides.size === 0) return reports;

			// The broker owns its reported providers; only extension providers
			// absent from its response need local credentials and a local probe.
			const brokerProviders = new Set(reports.map(report => report.provider));
			const localProviders = new Set<Provider>();
			for (const provider of this.#runtimeUsageProviderOverrides.keys()) {
				if (!brokerProviders.has(provider)) localProviders.add(provider);
			}
			if (localProviders.size === 0) return reports;
			const localReports = await this.#fetchLocalReports(options, localProviders);
			return localReports?.length ? [...reports, ...localReports] : reports;
		}
		return this.#fetchLocalReports(options);
	}

	/** Probe only the selected providers locally, preserving per-credential caching and cooldowns. */
	async #fetchLocalReports(
		options?: UsageReportsOptions,
		providerFilter?: ReadonlySet<Provider>,
	): Promise<UsageReport[] | null> {
		const requests = await this.#collectUsageRequests(options, providerFilter);
		if (requests.length === 0) return [];

		this.logger?.debug("Usage fetch requested", {
			providers: [...new Set(requests.map(request => request.provider))].sort(),
		});

		// Per-credential caching with jitter lives in #fetchUsageCached, so we
		// don't store the aggregated result here — doing so locks the widget to
		// a single decorrelation snapshot for 30s, defeating the jitter (some
		// accounts can be missing from one fetch and present in the next; the
		// aggregate cache freezes whichever set landed first).
		const forcedRefresh = this.#deps.cache.forcedRefresh(requests);
		const usageCacheEpoch = this.#deps.cache.epoch;
		const cacheKey = `${this.#deps.cache.reportsKey(requests)}\0${usageCacheEpoch}`;

		const inFlight = this.#usageReportsInFlight.get(cacheKey);
		if (inFlight) return raceSignal(inFlight, options?.signal, "usage fetch aborted");

		const promise = (async () => {
			for (const request of requests) {
				this.logger?.debug("Usage fetch queued", {
					provider: request.provider,
					credentialType: request.credential.type,
					baseUrl: request.baseUrl,
					accountId: request.credential.accountId,
					email: request.credential.email,
				});
			}

			const results = await this.#fetchUsageRequests(requests, forcedRefresh.providers);
			const reports = results.filter((report): report is UsageReport => report !== null);
			const deduped = dedupeUsageReports(reports, this.logger);
			// no outer cache write — see comment above.
			const resolved = deduped;
			this.logger?.debug("Usage fetch resolved", {
				reports: resolved.map(report => {
					const accountLabel =
						usageReportMetadataValue(report, "email") ??
						usageReportMetadataValue(report, "accountId") ??
						usageReportMetadataValue(report, "account") ??
						usageReportMetadataValue(report, "user") ??
						usageReportMetadataValue(report, "username") ??
						usageReportScopeAccountId(report);
					return {
						provider: report.provider,
						limits: report.limits.length,
						account: accountLabel,
					};
				}),
			});
			if (usageCacheEpoch === this.#deps.cache.epoch) this.#deps.cache.clearForceRefresh(forcedRefresh);
			return resolved;
		})().finally(() => {
			this.#usageReportsInFlight.delete(cacheKey);
		});

		this.#usageReportsInFlight.set(cacheKey, promise);
		return raceSignal(promise, options?.signal, "usage fetch aborted");
	}

	/**
	 * Discard cached usage reports before a user-requested refresh. The next
	 * read probes upstream serially per provider unless a failure cooldown is
	 * active. Failed probes never replay an invalidated last-good snapshot.
	 */
	async invalidate(provider?: string, signal?: AbortSignal): Promise<void> {
		await this.#deps.cache.clearReports(provider, () => this.#collectUsageRequests());

		if (this.#deps.store.invalidateUsageCache) {
			await this.#deps.store.invalidateUsageCache(provider, signal).catch(err => {
				logger.debug("Failed to notify store of stale usage", { err });
			});
		}
	}
}
