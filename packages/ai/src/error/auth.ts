import { attach, create, Flag } from "./flags";

/**
 * No API key / credential was available to dispatch a request.
 *
 * The default message preserves the historical `"No API key for provider: X"`
 * wording, which {@link Flag.AuthFailed}'s regex (`no api key`) keys off — but
 * the flag is also attached structurally so classification never depends on the
 * exact phrasing.
 */
export class MissingApiKeyError extends Error {
	readonly provider: string | undefined;

	constructor(provider?: string, message?: string) {
		super(message ?? (provider ? `No API key for provider: ${provider}` : "No API key available"));
		this.name = "MissingApiKeyError";
		this.provider = provider;
		attach(this, create(Flag.AuthFailed));
	}
}

/**
 * Every usable OAuth credential for a provider failed to refresh with a
 * retryable error (network blip, timeout, 5xx). The stored credentials are
 * intact, so this is classified transient: retrying the request can succeed,
 * unlike {@link MissingApiKeyError}. The refresh failure is kept as `cause`.
 */
export class OAuthRefreshUnavailableError extends Error {
	readonly provider: string;

	constructor(provider: string, cause: unknown) {
		super(
			`OAuth token refresh failed for provider ${provider}: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.name = "OAuthRefreshUnavailableError";
		this.provider = provider;
		attach(this, create(Flag.Transient));
	}
}

/** A user-facing login flow required an `onPrompt` callback that was not supplied. */
export class OnPromptRequiredError extends Error {
	constructor(providerLabel: string) {
		super(`${providerLabel} login requires onPrompt callback`);
		this.name = "OnPromptRequiredError";
	}
}

/** An interactive login asked for an API key but the user supplied an empty value. */
export class ApiKeyRequiredError extends Error {
	constructor(message = "API key is required") {
		super(message);
		this.name = "ApiKeyRequiredError";
	}
}

/**
 * A user cancelled an interactive login / device flow. Classified as an abort
 * so it is never surfaced as a retryable transient failure.
 */
export class LoginCancelledError extends Error {
	constructor(message = "Login cancelled") {
		super(message);
		this.name = "LoginCancelledError";
		attach(this, create(Flag.Abort));
	}
}

/**
 * A login run with `existing: "refuse"` (or a `replaceRowId` naming another
 * row) found a stored credential the new grant would overwrite. Nothing was
 * written and the new grant was dropped. Carries identity only, never tokens.
 */
export class CredentialExistsError extends Error {
	readonly code = "credential_exists";
	readonly rowId: number;
	readonly email: string | undefined;
	readonly orgName: string | undefined;

	constructor(rowId: number, identity: { email?: string; orgName?: string }) {
		super(`A stored credential already holds this account (row ${rowId}); nothing was written`);
		this.name = "CredentialExistsError";
		this.rowId = rowId;
		this.email = identity.email;
		this.orgName = identity.orgName;
	}
}
