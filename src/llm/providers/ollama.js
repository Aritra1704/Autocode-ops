import { config } from '../../config.js';

function trimTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function buildTimeoutError(timeoutMs, pathname) {
  const error = new Error(`Ollama request timed out after ${timeoutMs}ms for ${pathname}`);
  error.name = 'AbortError';
  error.code = 'OLLAMA_TIMEOUT';
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

function isRetryableOllamaError(error) {
  if (!error) {
    return false;
  }

  if (error.name === 'AbortError' || error.code === 'OLLAMA_TIMEOUT') {
    return true;
  }

  const message = `${error.message ?? ''}`;
  return /fetch failed|network|socket|ECONNRESET|ECONNREFUSED|EPIPE|timed out/i.test(message);
}

function buildGenerateBody(input) {
  const body = {
    model: input.model,
    prompt: input.prompt,
    stream: false,
    keep_alive: input.keepAlive,
  };

  if (input.system) {
    body.system = input.system;
  }

  if (input.format) {
    body.format = input.format;
  }

  const options = {
    temperature: input.temperature ?? 0.2,
    ...(input.options ?? {}),
  };

  if (Object.keys(options).length > 0) {
    body.options = options;
  }

  return body;
}

export function createOllamaClient(options = {}) {
  const baseUrl = trimTrailingSlash(options.baseUrl ?? config.ollamaBaseUrl);
  const keepAlive = options.keepAlive ?? config.ollamaKeepAlive;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const defaultTimeoutMs = options.timeoutMs ?? config.ollamaRequestTimeoutMs;
  const warmupTimeoutMs = options.warmupTimeoutMs ?? config.ollamaWarmupTimeoutMs;
  const maxRetries = options.maxRetries ?? config.ollamaMaxRetries;
  const logger = options.logger ?? null;
  const warmedModels = new Set();
  const warmupInflight = new Map();

  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is not available for the Ollama client');
  }

  async function request(pathname, requestOptions = {}) {
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
            throw new Error(
              `Ollama request failed with status ${response.status}: ${text.slice(0, 200)}`
            );
          }

          throw new Error(`Ollama returned non-JSON content: ${text.slice(0, 200)}`);
        }
      }

      if (!response.ok) {
        throw new Error(
          `Ollama request failed with status ${response.status}: ${text.slice(0, 200)}`
        );
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

  async function requestWithWarmRetry(operation, requestFactory) {
    const retries = operation.retries ?? maxRetries;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await requestFactory(attempt);
      } catch (error) {
        lastError = error;
        if (attempt >= retries || !isRetryableOllamaError(error) || !operation.model) {
          throw error;
        }

        if (operation.warmup) {
          try {
            await operation.warmup();
          } catch (warmupError) {
            logger?.warn?.(
              {
                err: warmupError,
                model: operation.model,
                attempt: attempt + 1,
                operation: operation.name,
              },
              'Ollama model warmup failed before retry'
            );
          }
        }
      }
    }

    throw lastError;
  }

  async function warmModel(model, options = {}) {
    const mode = options.mode ?? 'generate';
    const cacheKey = `${mode}:${model}`;

    if (!model) {
      throw new Error('warmModel requires a model');
    }

    if (!options.force && warmedModels.has(cacheKey)) {
      return { warmed: false, cached: true, model, mode };
    }

    if (!options.force && warmupInflight.has(cacheKey)) {
      return warmupInflight.get(cacheKey);
    }

    const warmupPromise = (async () => {
      if (mode === 'embed') {
        await request('/api/embed', {
          method: 'POST',
          timeoutMs: options.timeoutMs ?? warmupTimeoutMs,
          body: {
            model,
            input: ['warmup'],
            keep_alive: options.keepAlive ?? keepAlive,
          },
        });
      } else {
        await request('/api/generate', {
          method: 'POST',
          timeoutMs: options.timeoutMs ?? warmupTimeoutMs,
          body: {
            model,
            prompt: '',
            keep_alive: options.keepAlive ?? keepAlive,
          },
        });
      }

      warmedModels.add(cacheKey);
      return { warmed: true, cached: false, model, mode };
    })();

    warmupInflight.set(cacheKey, warmupPromise);

    try {
      return await warmupPromise;
    } finally {
      warmupInflight.delete(cacheKey);
    }
  }

  return {
    provider: 'ollama',
    baseUrl,
    keepAlive,

    async listModels() {
      const payload = await request('/api/tags');
      return payload?.models ?? [];
    },

    async healthCheck(options = {}) {
      const models = await this.listModels();
      const availableTags = new Set(models.map((model) => model.name));
      const requiredModels = options.requiredModels ?? [];
      const missingModels = requiredModels.filter((model) => !availableTags.has(model));

      return {
        ok: missingModels.length === 0,
        modelCount: models.length,
        models,
        missingModels,
      };
    },

    async generate(input) {
      const payload = await requestWithWarmRetry(
        {
          name: 'generate',
          model: input.model,
          retries: input.retries,
          warmup: () =>
            warmModel(input.model, {
              mode: 'generate',
              timeoutMs: input.warmupTimeoutMs,
              force: true,
            }),
        },
        () =>
          request('/api/generate', {
            method: 'POST',
            signal: input.signal,
            timeoutMs: input.timeoutMs,
            body: buildGenerateBody({
              ...input,
              keepAlive,
            }),
          })
      );

      return {
        responseText: payload?.response ?? '',
        totalDuration: payload?.total_duration ?? null,
        loadDuration: payload?.load_duration ?? null,
        promptEvalCount: payload?.prompt_eval_count ?? null,
        evalCount: payload?.eval_count ?? null,
        raw: payload,
      };
    },

    async warmModel(input) {
      return warmModel(input.model, {
        mode: input.mode,
        timeoutMs: input.timeoutMs,
        force: input.force,
        keepAlive: input.keepAlive,
      });
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

      let firstError = null;

      try {
        const payload = await requestWithWarmRetry(
          {
            name: 'embed',
            model,
            retries: input.retries,
            warmup: () =>
              warmModel(model, {
                mode: 'embed',
                timeoutMs: input.warmupTimeoutMs,
                force: true,
              }),
          },
          () =>
            request('/api/embed', {
              method: 'POST',
              timeoutMs: input.timeoutMs,
              body: {
                model,
                input: [content],
                keep_alive: keepAlive,
              },
            })
        );

        const vector =
          Array.isArray(payload?.embeddings) && Array.isArray(payload.embeddings[0])
            ? payload.embeddings[0]
            : Array.isArray(payload?.embedding)
              ? payload.embedding
              : null;

        if (!vector) {
          throw new Error('Ollama /api/embed returned no embedding vector');
        }

        return {
          embedding: vector,
          endpoint: '/api/embed',
          raw: payload,
        };
      } catch (error) {
        firstError = error;
      }

      try {
        const payload = await request('/api/embeddings', {
          method: 'POST',
          body: {
            model,
            prompt: content,
            keep_alive: keepAlive,
          },
        });

        const vector = Array.isArray(payload?.embedding) ? payload.embedding : null;
        if (!vector) {
          throw new Error('Ollama /api/embeddings returned no embedding vector');
        }

        return {
          embedding: vector,
          endpoint: '/api/embeddings',
          raw: payload,
        };
      } catch (fallbackError) {
        const details = [firstError?.message, fallbackError?.message]
          .filter(Boolean)
          .join(' | ');
        throw new Error(`Failed to generate embedding: ${details}`);
      }
    },
  };
}

