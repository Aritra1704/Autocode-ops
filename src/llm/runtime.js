import { createModelRef, parseModelRef } from './base.js';

export function createLlmRuntime(options = {}) {
  const providers = options.providers ?? {};
  const defaultProvider = options.defaultProvider ?? 'ollama';

  function resolveProvider(model) {
    const parsed = parseModelRef(model, defaultProvider);
    const providerClient = providers[parsed.provider];

    if (!providerClient) {
      throw new Error(`LLM provider is not configured: ${parsed.provider}`);
    }

    if (!parsed.model) {
      throw new Error(`LLM model is not configured for provider ${parsed.provider}`);
    }

    return {
      ...parsed,
      providerClient,
    };
  }

  return {
    providers,
    defaultProvider,

    resolveModel(model) {
      const parsed = parseModelRef(model, defaultProvider);
      return {
        ...parsed,
        modelRef: createModelRef(parsed.provider, parsed.model),
      };
    },

    async listModels(input = {}) {
      if (input.provider) {
        const providerClient = providers[input.provider];
        if (!providerClient?.listModels) {
          return [];
        }

        return providerClient.listModels(input);
      }

      const entries = await Promise.all(
        Object.entries(providers).map(async ([providerName, providerClient]) => ({
          provider: providerName,
          models: providerClient?.listModels ? await providerClient.listModels(input) : [],
        }))
      );

      return entries;
    },

    async healthCheck(input = {}) {
      if (input.provider) {
        const providerClient = providers[input.provider];
        if (!providerClient?.healthCheck) {
          return null;
        }

        return providerClient.healthCheck(input);
      }

      const checks = {};
      for (const [providerName, providerClient] of Object.entries(providers)) {
        if (!providerClient?.healthCheck) {
          continue;
        }

        checks[providerName] = await providerClient.healthCheck({
          ...input,
          requiredModels: input.requiredModelsByProvider?.[providerName] ?? [],
        });
      }

      return checks;
    },

    async generate(input) {
      const resolved = resolveProvider(input.model);
      const result = await resolved.providerClient.generate({
        ...input,
        model: resolved.model,
      });

      return {
        ...result,
        provider: resolved.provider,
        model: resolved.model,
        modelRef: resolved.modelRef,
      };
    },

    async warmModel(input) {
      const resolved = resolveProvider(input.model);
      if (!resolved.providerClient?.warmModel) {
        return {
          warmed: false,
          cached: true,
          model: resolved.model,
          provider: resolved.provider,
          mode: input.mode ?? 'generate',
        };
      }

      return resolved.providerClient.warmModel({
        ...input,
        model: resolved.model,
      });
    },

    async embed(input) {
      const resolved = resolveProvider(input.model);
      if (!resolved.providerClient?.embed) {
        throw new Error(`LLM provider does not support embeddings: ${resolved.provider}`);
      }

      const result = await resolved.providerClient.embed({
        ...input,
        model: resolved.model,
      });

      return {
        ...result,
        provider: resolved.provider,
        model: resolved.model,
        modelRef: resolved.modelRef,
      };
    },
  };
}

