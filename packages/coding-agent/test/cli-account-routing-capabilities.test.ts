import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	MANAGED_ROUTING_COMPLETE_COVERAGE,
	serializeManagedRoutingCapabilities,
} from "@oh-my-pi/pi-coding-agent/cli/account-routing-capabilities-cli";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
const pureModule = path.resolve(import.meta.dir, "../src/cli/account-routing-capabilities-cli.ts");

/** Current root help with the probe command removed, standing in for an older binary. */
const OLD_ROOT_HELP = `USAGE
  omp <command> [options]

COMMANDS
  launch  Start an interactive session
  acp     Run omp as an ACP (Agent Client Protocol) server over stdio
`;

async function probe(
	args: string[],
	envExtra: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; homeEntries: string[] }> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-arc-home-"));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-arc-cwd-"));
	try {
		const proc = Bun.spawn([process.execPath, cliEntry, "account-routing-capabilities", ...args], {
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			// Scrubbed env: nothing inherited, so no provider keys, auth or proxy settings leak in.
			env: { PATH: process.env.PATH ?? "", HOME: home, PI_NO_PTY: "1", ...envExtra },
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { exitCode, stdout, stderr, homeEntries: fs.readdirSync(home).filter(entry => entry !== "Library") }; // Library/Caches/bun is the runtime transpiler cache, not omp state
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function expected(mode: "model" | "metadata"): string {
	const model = mode === "model";
	return `${JSON.stringify({
		version: 1,
		provider: "anthropic",
		managedAccountRouting: {
			modelDispatch: model ? "allowed" : "forbidden",
			completeCoverage: false,
			purposes: ["model-dispatch", "metadata", "usage-refresh"],
			sourceIdentity: "v1",
			exactUsageRefresh: "v1",
		},
		build: { version: VERSION },
	})}\n`;
}

describe("omp account-routing-capabilities", () => {
	it("prints exact model-mode JSON by default without touching HOME", async () => {
		const result = await probe([]);
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe(expected("model"));
		expect(result.homeEntries).toEqual([]);
	}, 30_000);

	it("prints exact metadata-mode JSON; env alone does not change the mode", async () => {
		const explicit = await probe(["--mode", "metadata"]);
		expect(explicit.exitCode).toBe(0);
		expect(explicit.stdout).toBe(expected("metadata"));
		const equalsForm = await probe(["--mode=metadata"]);
		expect(equalsForm.stdout).toBe(expected("metadata"));
		const envOnly = await probe([], { OMP_HOST_ACCOUNT_ROUTING: "metadata", OMP_UNKNOWN: "x" });
		expect(envOnly.stdout).toBe(expected("model"));
	}, 60_000);

	it("rejects bad arguments with usage on stderr and no JSON", async () => {
		for (const args of [["--mode"], ["--mode", "other"], ["--mode=x"], ["extra"], ["--mode", "model", "extra"]]) {
			const result = await probe(args);
			expect(result.exitCode, args.join(" ")).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("Usage: omp account-routing-capabilities");
		}
	}, 120_000);

	it("lists the command in root help; an older help string lacks it", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-arc-help-"));
		try {
			const proc = Bun.spawn([process.execPath, cliEntry, "--help"], {
				cwd: home,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: { PATH: process.env.PATH ?? "", HOME: home },
			});
			const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
			expect(code).toBe(0);
			expect(out).toContain("account-routing-capabilities");
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
		expect(OLD_ROOT_HELP).not.toContain("account-routing-capabilities");
	}, 30_000);

	it("serializer honors the coverage constant and overrides", () => {
		expect(MANAGED_ROUTING_COMPLETE_COVERAGE).toBe(false);
		const model = JSON.parse(serializeManagedRoutingCapabilities({ mode: "model", buildVersion: null }));
		expect(model.managedAccountRouting.completeCoverage).toBe(false);
		expect(model.build).toEqual({ version: null });
		const covered = JSON.parse(
			serializeManagedRoutingCapabilities({ mode: "model", buildVersion: "1", completeCoverage: true }),
		);
		expect(covered.managedAccountRouting.completeCoverage).toBe(true);
		const metadata = JSON.parse(
			serializeManagedRoutingCapabilities({ mode: "metadata", buildVersion: "1", completeCoverage: true }),
		);
		expect(metadata.managedAccountRouting).toMatchObject({ modelDispatch: "forbidden", completeCoverage: false });
	});

	it("keeps the probe module free of imports", () => {
		expect(fs.readFileSync(pureModule, "utf8")).not.toMatch(/^\s*(import|export .* from)\b/m);
	});
});
