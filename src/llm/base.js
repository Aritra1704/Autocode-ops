export const LLM_PROVIDER_NAMES = ['ollama', 'gemini'];
export const MODEL_REF_SEPARATOR = '::';

export function createModelRef(provider, model) {
  const normalizedProvider = `${provider ?? ''}`.trim().toLowerCase();
  const normalizedModel = `${model ?? ''}`.trim();

  if (!normalizedModel) {
    throw new Error('createModelRef requires a model');
  }

  if (!normalizedProvider) {
    return normalizedModel;
  }

  return `${normalizedProvider}${MODEL_REF_SEPARATOR}${normalizedModel}`;
}

export function parseModelRef(modelRef, defaultProvider = 'ollama') {
  if (typeof modelRef === 'object' && modelRef && !Array.isArray(modelRef)) {
    const provider = `${modelRef.provider ?? defaultProvider}`.trim().toLowerCase();
    const model = `${modelRef.model ?? ''}`.trim();
    return {
      provider,
      model,
      modelRef: createModelRef(provider, model),
    };
  }

  const raw = `${modelRef ?? ''}`.trim();
  if (!raw) {
    return {
      provider: defaultProvider,
      model: '',
      modelRef: '',
    };
  }

  const separatorIndex = raw.indexOf(MODEL_REF_SEPARATOR);
  if (separatorIndex === -1) {
    return {
      provider: defaultProvider,
      model: raw,
      modelRef: createModelRef(defaultProvider, raw),
    };
  }

  const provider = raw.slice(0, separatorIndex).trim().toLowerCase() || defaultProvider;
  const model = raw.slice(separatorIndex + MODEL_REF_SEPARATOR.length).trim();

  return {
    provider,
    model,
    modelRef: createModelRef(provider, model),
  };
}

export function uniqueModelRefs(values = []) {
  return [...new Set(
    values
      .map((value) => `${value ?? ''}`.trim())
      .filter(Boolean)
  )];
}

