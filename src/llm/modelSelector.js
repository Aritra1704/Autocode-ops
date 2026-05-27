import { config } from '../config.js';
import { createModelRef, parseModelRef, uniqueModelRefs } from './base.js';

function createResolvedModels(overrides = {}) {
  const localModels = {
    planner: createModelRef('ollama', overrides.planner ?? config.modelPlanner),
    coder: createModelRef('ollama', overrides.coder ?? config.modelCoder),
    fast: createModelRef('ollama', overrides.fast ?? config.modelFast),
    review: createModelRef('ollama', overrides.review ?? config.modelReview),
    security: createModelRef('ollama', overrides.security ?? config.modelReview),
    embed: createModelRef('ollama', overrides.embed ?? config.modelEmbed),
  };

  const cloudModels = {
    planner: createModelRef('gemini', overrides.plannerCloud ?? config.modelPlannerCloud),
    review: createModelRef('gemini', overrides.reviewCloud ?? config.modelReviewCloud),
    security: createModelRef('gemini', overrides.securityCloud ?? config.modelSecurityCloud),
    fast: createModelRef('gemini', overrides.fastCloud ?? config.modelFastCloud),
  };

  return {
    localModels,
    cloudModels,
    hybridEnabled: config.orchestratorMode === 'hybrid' && config.geminiEnabled,
    cloudFallbackEnabled: config.geminiEnabled,
  };
}

export function createModelSelector(overrides = {}) {
  const { localModels, cloudModels, hybridEnabled, cloudFallbackEnabled } =
    createResolvedModels(overrides);

  function requireRole(role) {
    if (!localModels[role] && !cloudModels[role]) {
      throw new Error(`Unknown Stallone model role: ${role}`);
    }
  }

  function selectWithFallback(role) {
    requireRole(role);
    const plannerLocal = localModels.planner;
    const fastLocal = localModels.fast;
    const plannerCloud = cloudModels.planner;

    switch (role) {
      case 'planner':
        return uniqueModelRefs(
          hybridEnabled
            ? [plannerCloud, plannerLocal, fastLocal]
            : [plannerLocal, cloudFallbackEnabled ? plannerCloud : null, fastLocal]
        );
      case 'coder':
        return uniqueModelRefs([
          localModels.coder,
          hybridEnabled && cloudFallbackEnabled ? plannerCloud : null,
          plannerLocal,
          fastLocal,
        ]);
      case 'review':
        return uniqueModelRefs(
          hybridEnabled
            ? [cloudModels.review, localModels.review, plannerLocal, fastLocal]
            : [
                localModels.review,
                cloudFallbackEnabled ? cloudModels.review : null,
                plannerLocal,
                fastLocal,
              ]
        );
      case 'security':
        return uniqueModelRefs(
          hybridEnabled
            ? [cloudModels.security, localModels.security, plannerLocal, fastLocal]
            : [
                localModels.security,
                cloudFallbackEnabled ? cloudModels.security : null,
                plannerLocal,
                fastLocal,
              ]
        );
      case 'fast':
        return uniqueModelRefs([
          localModels.fast,
          cloudFallbackEnabled ? cloudModels.fast : null,
          plannerLocal,
        ]);
      case 'embed':
        return uniqueModelRefs([localModels.embed]);
      default:
        throw new Error(`Unknown Stallone model role: ${role}`);
    }
  }

  return {
    list() {
      return {
        planner: selectWithFallback('planner')[0],
        coder: selectWithFallback('coder')[0],
        fast: selectWithFallback('fast')[0],
        review: selectWithFallback('review')[0],
        security: selectWithFallback('security')[0],
        embed: selectWithFallback('embed')[0],
      };
    },

    select(role) {
      const model = selectWithFallback(role)[0];
      if (!model) {
        throw new Error(`Unknown Stallone model role: ${role}`);
      }

      return model;
    },

    selectWithFallback,

    requiredModelsByProvider() {
      const refs = Object.values(this.list());
      const modelsByProvider = {
        ollama: [],
        gemini: [],
      };

      for (const modelRef of refs) {
        const resolved = parseModelRef(modelRef);
        if (!resolved.model) {
          continue;
        }
        modelsByProvider[resolved.provider] ??= [];
        modelsByProvider[resolved.provider].push(resolved.model);
      }

      // Local fallback models remain important in hybrid mode even when Gemini is primary.
      modelsByProvider.ollama.push(
        parseModelRef(localModels.planner).model,
        parseModelRef(localModels.coder).model,
        parseModelRef(localModels.fast).model,
        parseModelRef(localModels.review).model,
        parseModelRef(localModels.embed).model
      );

      if (cloudFallbackEnabled) {
        modelsByProvider.gemini.push(
          parseModelRef(cloudModels.planner).model,
          parseModelRef(cloudModels.review).model,
          parseModelRef(cloudModels.security).model,
          parseModelRef(cloudModels.fast).model
        );
      }

      return {
        ollama: [...new Set(modelsByProvider.ollama.filter(Boolean))],
        gemini: [...new Set(modelsByProvider.gemini.filter(Boolean))],
      };
    },
  };
}
