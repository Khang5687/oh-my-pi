/**
 * `omp account-routing-capabilities`: static managed-routing capability probe.
 *
 * Pure on purpose: no auth, settings, model, plugin or network imports, so the
 * command answers before any of those load. A managed host probes an installed
 * binary with it before marking a managed runtime supported.
 */

/**
 * Whether every provider-calling surface honors managed routing. The auxiliary
 * caller cutover flips this single constant to true; the CLI output and the
 * owned-runtime adapter both read it, so they cannot drift.
 */
export const MANAGED_ROUTING_COMPLETE_COVERAGE = false;

export type ManagedRoutingMode = "model" | "metadata";

export const ACCOUNT_ROUTING_CAPABILITIES_USAGE = "Usage: omp account-routing-capabilities [--mode model|metadata]\n";

export interface ManagedRoutingCapabilitiesInput {
	mode: ManagedRoutingMode;
	/** Build constant of the running binary; null when unavailable. */
	buildVersion: string | null;
	completeCoverage?: boolean;
}

/** Serialize the version-1 capability document: fixed key order, one trailing LF. */
export function serializeManagedRoutingCapabilities(input: ManagedRoutingCapabilitiesInput): string {
	const metadata = input.mode === "metadata";
	const document = {
		version: 1,
		provider: "anthropic",
		managedAccountRouting: {
			modelDispatch: metadata ? "forbidden" : "allowed",
			completeCoverage: metadata ? false : (input.completeCoverage ?? MANAGED_ROUTING_COMPLETE_COVERAGE),
			purposes: ["model-dispatch", "metadata", "usage-refresh"],
			sourceIdentity: "v1",
			exactUsageRefresh: "v1",
		},
		build: { version: input.buildVersion },
	};
	return `${JSON.stringify(document)}\n`;
}

/** Parse `[--mode model|metadata]`; undefined for anything else. */
export function parseAccountRoutingCapabilitiesArgs(args: readonly string[]): ManagedRoutingMode | undefined {
	if (args.length === 0) return "model";
	let value: string | undefined;
	if (args.length === 2 && args[0] === "--mode") value = args[1];
	else if (args.length === 1 && args[0].startsWith("--mode=")) value = args[0].slice("--mode=".length);
	return value === "model" || value === "metadata" ? value : undefined;
}

/** Run the command; returns the process exit code. */
export function runAccountRoutingCapabilities(
	args: readonly string[],
	buildVersion: string | null,
	out: { stdout(text: string): void; stderr(text: string): void },
): number {
	const mode = parseAccountRoutingCapabilitiesArgs(args);
	if (!mode) {
		out.stderr(ACCOUNT_ROUTING_CAPABILITIES_USAGE);
		return 2;
	}
	out.stdout(serializeManagedRoutingCapabilities({ mode, buildVersion }));
	return 0;
}
