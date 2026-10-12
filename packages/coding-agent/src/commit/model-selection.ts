import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, ApiKey, Model } from "@oh-my-pi/pi-ai";
import type { ApiKeyResolverRegistry } from "../config/api-key-resolver";
import { isModelAuthAvailable, type ModelRegistry } from "../config/model-registry";
import {
	getModelMatchPreferences,
	type ModelLookupRegistry,
	parseModelPattern,
	resolveModelRoleValue,
	resolveRoleSelection,
} from "../config/model-resolver";
import { CHAT_MODEL_ROLE_IDS } from "../config/model-roles";
import type { Settings } from "../config/settings";
import MODEL_PRIO from "../priority.json" with { type: "json" };
import { concreteThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

export interface ResolvedCommitModel {
	model: Model<Api>;
	/**
	 * Resolver for the model's bearer: re-resolves on 401 / usage-limit so the
	 * whole commit pipeline (analysis, map/reduce, changelog) inherits the
	 * central force-refresh + account-rotation policy.
	 */
	apiKey: ApiKey;
	/**
	 * Commit-time inference is stateless: session-level auto classification
	 * isn't available, so an explicit `:auto` selector collapses to "no
	 * override" and the model's own default level fills in.
	 */
	thinkingLevel?: ThinkingLevel;
}

type CommitModelRegistry = ModelLookupRegistry &
	ApiKeyResolverRegistry & {
		getApiKey: (model: Model<Api>) => Promise<string | undefined>;
	} & Partial<Pick<ModelRegistry, "isManagedClaude" | "isAuthAvailable">>;

export async function resolvePrimaryModel(
	override: string | undefined,
	settings: Settings,
	modelRegistry: CommitModelRegistry,
): Promise<ResolvedCommitModel> {
	const available = modelRegistry.getAvailable();
	const matchPreferences = getModelMatchPreferences(settings);
	const resolved = override
		? resolveModelRoleValue(override, available, { settings, matchPreferences })
		: resolveRoleSelection(["commit", "smol", ...CHAT_MODEL_ROLE_IDS], settings, available);
	const model = resolved?.model;
	if (!model) {
		throw new Error("No model available for commit generation");
	}
	if (!(await isModelAuthAvailable(modelRegistry, model))) {
		throw new Error(`No API key available for model ${model.provider}/${model.id}`);
	}
	return {
		model,
		apiKey: modelRegistry.resolver(model, undefined, "other_auxiliary"),
		thinkingLevel: concreteThinkingLevel(resolved?.thinkingLevel),
	};
}

export async function resolveSmolModel(
	settings: Settings,
	modelRegistry: CommitModelRegistry,
	fallbackModel: Model<Api>,
	fallbackApiKey: ApiKey,
): Promise<ResolvedCommitModel> {
	const available = modelRegistry.getAvailable();
	const resolvedSmol = resolveRoleSelection(["smol"], settings, available);
	if (resolvedSmol?.model) {
		if (await isModelAuthAvailable(modelRegistry, resolvedSmol.model)) {
			return {
				model: resolvedSmol.model,
				apiKey: modelRegistry.resolver(resolvedSmol.model, undefined, "other_auxiliary"),
				thinkingLevel: concreteThinkingLevel(resolvedSmol.thinkingLevel),
			};
		}
	}

	const matchPreferences = getModelMatchPreferences(settings);
	for (const pattern of MODEL_PRIO.smol) {
		const candidate = parseModelPattern(pattern, available, matchPreferences).model;
		if (!candidate) continue;
		if (await isModelAuthAvailable(modelRegistry, candidate)) {
			return {
				model: candidate,
				apiKey: modelRegistry.resolver(candidate, undefined, "other_auxiliary"),
			};
		}
	}

	return { model: fallbackModel, apiKey: fallbackApiKey };
}
