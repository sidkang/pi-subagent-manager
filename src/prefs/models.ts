import { THINKING_LEVELS, type ThinkingLevel } from "../types.ts";

const MODEL_IDENTITY = /^[^\s/]+\/[^\s]+$/;

function validateModelPreference(value: unknown, label: string): string {
  if (typeof value !== "string" || !MODEL_IDENTITY.test(value))
    throw new Error(`${label} must be provider/model-id`);
  return value;
}

export function getModelPreferences(type: {
  models?: unknown;
  model?: unknown;
}): string[] | undefined {
  const hasModels = type.models !== undefined;
  const hasModel = type.model !== undefined;
  if (hasModels && hasModel)
    throw new Error("Specify either models or model, not both");
  if (hasModels) {
    if (!Array.isArray(type.models))
      throw new Error("models must be an array of provider/model-id strings");
    if (type.models.length === 0)
      throw new Error(
        "models must not be empty; omit models to inherit the parent/default model",
      );
    const models = type.models.map((value, index) =>
      validateModelPreference(value, `models[${index}]`),
    );
    if (new Set(models).size !== models.length)
      throw new Error("models contains duplicate entries");
    return [...models];
  }
  if (hasModel) return [validateModelPreference(type.model, "model")];
  return undefined;
}

/**
 * Narrows one spawn's definition copy to a model from the type's own list. The choice uses pi's
 * `provider/model-id[:thinking]` form: an exact list entry wins, otherwise a trailing thinking level
 * is split off, so ids such as `cursor/x@1m:fast` keep their colon.
 */
export function chooseModel<
  T extends { name: string; models?: unknown; model?: unknown; thinkingLevel?: ThinkingLevel },
>(type: T, choice: string): T {
  const preferences = getModelPreferences(type);
  if (preferences === undefined)
    throw new Error(
      `Agent type ${JSON.stringify(type.name)} has no models list, so it runs on its parent's model; omit model.`,
    );
  const colon = choice.lastIndexOf(":");
  const suffix = choice.slice(colon + 1) as ThinkingLevel;
  const split = !preferences.includes(choice) && colon !== -1 && THINKING_LEVELS.includes(suffix);
  const model = split ? choice.slice(0, colon) : choice;
  if (!preferences.includes(model))
    throw new Error(
      `Agent type ${JSON.stringify(type.name)} allows models [${preferences.join(", ")}], not ${JSON.stringify(model)}.`,
    );
  const { model: _legacy, ...rest } = type;
  return { ...rest, models: [model], ...(split ? { thinkingLevel: suffix } : {}) } as T;
}

export function modelIdentity(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

export class ModelPreferenceError extends Error {
  constructor(
    message: string,
    readonly scopedModelFiltering: boolean,
  ) {
    super(message);
  }

  get summary(): string {
    return this.scopedModelFiltering
      ? "No preferred model is available in /scoped-models; update the scope or this type's models."
      : "No preferred model is available; check provider credentials or this type's models.";
  }
}

export function selectPreferredModel(
  type: { name: string; models?: unknown; model?: unknown },
  eligibleModels: readonly { model: { provider: string; id: string } }[],
  scopedModelFiltering = true,
): string | undefined {
  const preferences = getModelPreferences(type);
  if (preferences === undefined) return undefined;
  const available = eligibleModels.map(({ model }) => modelIdentity(model));
  for (const preference of preferences) {
    if (available.includes(preference)) return preference;
  }
  const preferenceList = `[${preferences.join(", ")}]`;
  const availableList = available.length === 0 ? "(none)" : `[${available.join(", ")}]`;
  if (!scopedModelFiltering) {
    throw new ModelPreferenceError(
      `Agent type ${JSON.stringify(type.name)} prefers models ${preferenceList}, but none are available. Available models: ${availableList}. Update this agent type's models list.`,
      false,
    );
  }
  throw new ModelPreferenceError(
    `Agent type ${JSON.stringify(type.name)} prefers scoped models ${preferenceList}, but none are available in /scoped-models. Available scoped models: ${availableList}. Update /scoped-models or this agent type's models list.`,
    true,
  );
}
