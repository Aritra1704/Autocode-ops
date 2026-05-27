import { config } from '../../config.js';

function trimTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function buildTimeoutError(timeoutMs, pathname) {
  const error = new Error(`Gemini request timed out after ${timeoutMs}ms for ${pathname}`);
  error.name = 'AbortError';
  error.code = 'GEMINI_TIMEOUT';
  return error;
}

function combineSignals(signals) {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) {
    return { signal: undefined, dispose() {} };
  }

  if (activeSignals.length === 1) {
    return { signal: activeSignals[0], dispose() {} };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();

  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort();
      return { signal: controller.signal, dispose() {} };
    }
  }

  for (const signal of activeSignals) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose() {
      for (const signal of activeSignals) {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

function isRetryableGeminiError(error) {
  if (!error) {
    return false;
  }

  if (error.name === 'AbortError' || error.code === 'GEMINI_TIMEOUT') {
    return true;
  }

  if (Number.isInteger(error.status) && [408, 429, 500, 502, 503, 504].includes(error.status)) {
    return true;
  }

  const message = `${error.message ?? ''}`;
  return /fetch failed|network|socket|ECONNRESET|ECONNREFUSED|EPIPE|timed out/i.test(message);
}

function createTextPart(text) {
  return {
    parts: [
      {
        text: `${text ?? ''}`,
      },
    ],
  };
}

function buildGenerationConfig(input) {
  const options = input.options ?? {};
  const config = {};
  const temperature = input.temperature ?? options.temperature;

  if (typeof temperature === 'number') {
    config.temperature = temperature;
  }
  if (typeof options.topP === 'number') {
    config.topP = options.topP;
  }
  if (typeof options.topK === 'number') {
    config.topK = options.topK;
  }
  if (Array.isArray(options.stopSequences) && options.stopSequences.length > 0) {
    config.stopSequences = options.stopSequences;
  }
  if (typeof options.maxOutputTokens === 'number') {
    config.maxOutputTokens = options.maxOutputTokens;
  }

  config.responseMimeType = input.format === 'json' ? 'application/json' : 'text/plain';
  return config;
}

function buildGenerateBody(input) {
  const body = {
    contents: [createTextPart(input.prompt ?? '')],
    generationConfig: buildGenerationConfig(input),
  };

  if (input.system) {
    body.systemInstruction = createTextPart(input.system);
  }

  return body;
}

function extractCandidateText(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const first = candidates[0];
  const parts = Array.isArray(first?.content?.parts) ? first.content.parts : [];
  const texts = parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean);

  if (texts.length > 0) {
    return texts.join('\n');
  }

  return '';
}

export function createGeminiClient(options = {}) {
  const apiKey = `${options.apiKey ?? config.geminiApiKey ?? ''}`.trim();
  const baseUrl = trimTrailingSlash(options.baseUrl ?? config.geminiApiBaseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const defaultTimeoutMs = options.timeoutMs ?? config.geminiRequestTimeoutMs;
  const maxRetries = options.maxRetries ?? config.geminiMaxRetries;

  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is not available for the Gemini client');
  }

  async function request(pathname, requestOptions = {}) {
    if (!apiKey) {
      const error = new Error('Gemini API key is not configured');
      error.code = 'GEMINI_MISSING_API_KEY';
      throw error;
    }

    const timeoutMs = requestOptions.timeoutMs ?? defaultTimeoutMs;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timeoutController.abort(buildTimeoutError(timeoutMs, pathname));
    }, timeoutMs);
    const combined = combineSignals([requestOptions.signal, timeoutController.signal]);

    try {
      const response = await fetchImpl(`${baseUrl}${pathname}`, {
        method: requestOptions.method ?? 'GET',
        signal: combined.signal,
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
          ...(requestOptions.headers ?? {}),
        },
        body:
          typeof requestOptions.body === 'undefined'
            ? undefined
            : JSON.stringify(requestOptions.body),
      });

      const text = await response.text();
      let payload = null;

      if (text.length > 0) {
        try {
          payload = JSON.parse(text);
        } catch {
          if (!response.ok) {
            const error = new Error(
              `Gemini request failed with status ${response.status}: ${text.slice(0, 200)}`
            );
            error.status = response.status;
            throw error;
          }

          throw new Error(`Gemini returned non-JSON content: ${text.slice(0, 200)}`);
        }
      }

      if (!response.ok) {
        const errorMessage =
          payload?.error?.message ??
          `Gemini request failed with status ${response.status}: ${text.slice(0, 200)}`;
        const error = new Error(errorMessage);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }

      return payload;
    } catch (error) {
      if (timeoutController.signal.aborted && requestOptions.signal?.aborted !== true) {
        const reason = timeoutController.signal.reason;
        throw reason instanceof Error ? reason : buildTimeoutError(timeoutMs, pathname);
      }

      throw error;
    } finally {
      clearTimeout(timer);
      combined.dispose();
    }
  }

  async function requestWithRetry(operation, requestFactory) {
    const retries = operation.retries ?? maxRetries;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await requestFactory(attempt);
      } catch (error) {
        lastError = error;
        if (attempt >= retries || !isRetryableGeminiError(error)) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  return {
    provider: 'gemini',
    baseUrl,
    apiKeyConfigured: apiKey.length > 0,

    async listModels() {
      if (!apiKey) {
        return [];
      }

      const models = [];
      let pageToken = null;

      do {
        const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : '';
        const payload = await request(`/models${query}`);
        models.push(...(payload?.models ?? []));
        pageToken = payload?.nextPageToken ?? null;
      } while (pageToken);

      return models;
    },

    async healthCheck(options = {}) {
      if (!apiKey) {
        return {
          ok: false,
          disabled: true,
          modelCount: 0,
          models: [],
          missingModels: options.requiredModels ?? [],
        };
      }

      const models = await this.listModels();
      const available = new Set(
        models.flatMap((model) => [model.baseModelId, model.name?.replace(/^models\//, '')]).filter(Boolean)
      );
      const requiredModels = options.requiredModels ?? [];
      const missingModels = requiredModels.filter((model) => !available.has(model));

      return {
        ok: missingModels.length === 0,
        modelCount: models.length,
        models,
        missingModels,
      };
    },

    async generate(input) {
      const payload = await requestWithRetry(
        {
          name: 'generate',
          retries: input.retries,
        },
        () =>
          request(`/models/${encodeURIComponent(input.model)}:generateContent`, {
            method: 'POST',
            signal: input.signal,
            timeoutMs: input.timeoutMs,
            body: buildGenerateBody(input),
          })
      );

      const usageMetadata = payload?.usageMetadata ?? {};

      return {
        responseText: extractCandidateText(payload),
        totalDuration: null,
        loadDuration: null,
        promptEvalCount: usageMetadata.promptTokenCount ?? null,
        evalCount: usageMetadata.candidatesTokenCount ?? null,
        raw: payload,
      };
    },

    async warmModel(input = {}) {
      return {
        warmed: false,
        cached: true,
        model: input.model ?? null,
        mode: input.mode ?? 'generate',
      };
    },

    async embed(input) {
      const model = input.model;
      const content = `${input.input ?? ''}`.trim();

      if (!model) {
        throw new Error('embed requires a model');
      }

      if (!content) {
        throw new Error('embed requires non-empty input');
      }

      const payload = await requestWithRetry(
        {
          name: 'embed',
          retries: input.retries,
        },
        () =>
          request(`/models/${encodeURIComponent(model)}:embedContent`, {
            method: 'POST',
            signal: input.signal,
            timeoutMs: input.timeoutMs,
            body: {
              model: `models/${model}`,
              content: {
                parts: [{ text: content }],
              },
            },
          })
      );

      const vector =
        Array.isArray(payload?.embedding?.values)
          ? payload.embedding.values
          : Array.isArray(payload?.embeddings?.[0]?.values)
            ? payload.embeddings[0].values
            : null;

      if (!vector) {
        throw new Error('Gemini embedContent returned no embedding vector');
      }

      return {
        embedding: vector,
        endpoint: ':embedContent',
        raw: payload,
      };
    },
  };
}

