/**
 * AI client.
 *
 * Four of the supported providers (Mesh, OpenRouter, OpenAI, Groq) speak the
 * OpenAI Chat Completions format and one (Anthropic) speaks the Messages API.
 * Both are implemented here over a shared core — the deadline, the idle
 * watchdog, the retry policy and the SSE frame reader are identical, and only
 * the request builder and the frame interpreter differ. Those live in
 * `providers.js`.
 *
 * No vendor SDK is used: the wire formats are small enough to own, and a
 * dependency per provider would not survive the next API revision anyway.
 *
 * Reference: https://developers.meshapi.ai/
 */

import {
  buildChatRequest,
  buildModelsRequest,
  providerOrDefault,
  readCompletionText,
  readCompletionUsage,
  readStreamFrame,
} from './providers.js';

export { DEFAULT_PROVIDER_ID, PROVIDERS, providerOrDefault } from './providers.js';

/* ---------------------------------------------------------------------------
 * Timing policy.
 *
 * These are the numbers that decide whether a slow answer finishes or gets
 * cancelled, so they are named rather than inlined:
 *
 *   STREAM_TIMEOUT_MS   ceiling on one whole streamed answer
 *   STREAM_IDLE_MS      gap between chunks, re-armed on every chunk, so a long
 *                       answer that keeps producing tokens is never killed
 *   COMPLETE_TIMEOUT_MS ceiling on the short non-streaming helper calls
 *   RETRY_DELAY_MS      pause before the single silent retry
 * ------------------------------------------------------------------------- */

export const STREAM_TIMEOUT_MS = 150_000;
export const STREAM_IDLE_MS = 40_000;
export const COMPLETE_TIMEOUT_MS = 45_000;
export const RETRY_DELAY_MS = 600;

export class AiError extends Error {
  /**
   * @param {string} message
   * @param {{status?:number, code?:string, retryable?:boolean}} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'AiError';
    this.status = meta.status ?? 0;
    this.code = meta.code ?? 'ai_error';
    this.retryable = meta.retryable ?? false;
  }
}

/**
 * Turns a non-2xx response into a message a human can act on.
 *
 * The wording names the provider, because "Mesh rejected the key" is misleading
 * when the user just switched to Groq, and it says what to do rather than
 * repeating the status code.
 *
 * @param {Response} response
 * @param {import('./providers.js').Provider} provider
 */
async function describeFailure(response, provider) {
  const name = provider?.label || 'The provider';
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || body?.message || body?.error || '';
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {
    try {
      detail = (await response.text()).slice(0, 400);
    } catch {
      detail = '';
    }
  }

  const byStatus = {
    400: `${name} rejected the request. This usually means the model id is not one this key can use, `
      + 'or the conversation contains something the API could not parse.',
    401: `${name} rejected the API key. Check the key in Settings — it should start with "${provider?.keyPrefix || ''}".`,
    402: `${name} reports insufficient credit for this request.`,
    403: `This key is not permitted to use the requested model on ${name}.`,
    404: `Model not found on ${name}. Use "Load models" in Settings to pick one this key can reach.`,
    413: 'The request was too large for this model. Try a shorter message or a smaller diff.',
    429: `Rate limit or spend cap reached on your ${name} key. Wait a moment or check your dashboard.`,
    500: `${name} had a server error. Retrying usually works.`,
    502: `${name} could not reach the upstream provider.`,
    503: `The requested model is temporarily unavailable on ${name}.`,
    529: `${name} is overloaded right now. Try again shortly.`,
  };

  const message = byStatus[response.status] || `${name} request failed (HTTP ${response.status}).`;
  return new AiError(detail ? `${message} — ${detail}` : message, {
    status: response.status,
    code: response.status === 401 ? 'invalid_api_key' : 'upstream_error',
    retryable: response.status >= 500 || response.status === 429 || response.status === 529,
  });
}

/**
 * Builds a signal that aborts on either the caller's cancellation or a deadline,
 * and reports which one happened.
 *
 * The caller's signal is forwarded rather than replaced, so pressing Stop in the
 * UI still cancels immediately; the deadline is an additional bound, not an
 * alternative to it.
 *
 * @param {AbortSignal|undefined} external
 * @param {number} timeoutMs
 * @param {string} code Error code to use when the deadline is what fired.
 * @returns {{signal:AbortSignal, clear:()=>void, timedOut:()=>boolean, describe:(error:any)=>any}}
 */
function withDeadline(external, timeoutMs, code, label = 'The provider') {
  const controller = new AbortController();
  let expired = false;

  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);

  const forward = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', forward, { once: true });
  }

  return {
    signal: controller.signal,
    /** Aborts early for a reason the caller tracks itself (a stalled stream). */
    abort: () => controller.abort(),
    clear: () => {
      clearTimeout(timer);
      external?.removeEventListener?.('abort', forward);
    },
    timedOut: () => expired,
    // Turns an opaque AbortError into something the UI can explain.
    describe: (error) => {
      if (error?.name !== 'AbortError') return error;
      if (!expired) return error; // The user pressed Stop.
      return new AiError(
        `${label} did not answer within ${Math.round(timeoutMs / 1000)}s, so the request was cancelled.`,
        { code, retryable: true },
      );
    },
  };
}

/**
 * Lists models available to this key.
 * @param {{apiKey:string, baseUrl?:string, signal?:AbortSignal}} params
 * @returns {Promise<{id:string, owned_by?:string}[]>}
 */
export async function listModels({ apiKey, providerId, baseUrl, signal }) {
  if (!apiKey) throw new AiError('No API key configured.', { code: 'missing_api_key' });

  const provider = providerOrDefault(providerId);
  const { url, headers } = buildModelsRequest(provider, { apiKey, baseUrl });

  let response;
  try {
    response = await fetch(url, { headers, signal });
  } catch (error) {
    throw new AiError(`Could not reach ${provider.label}: ${error.message}`, {
      code: 'network_error',
      retryable: true,
    });
  }

  if (!response.ok) throw await describeFailure(response, provider);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new AiError(`${provider.label} returned a model list that could not be read.`, {
      code: 'bad_response',
    });
  }

  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];

  return list
    .map((model) => ({
      id: typeof model === 'string' ? model : model.id || model.name,
      owned_by: model.owned_by || model.provider || model.display_name || provider.label,
    }))
    .filter((model) => typeof model.id === 'string' && model.id.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Verifies a key with the cheapest possible call.
 * @param {{apiKey:string, baseUrl?:string}} params
 */
export async function verifyKey({ apiKey, providerId, baseUrl }) {
  const models = await listModels({ apiKey, providerId, baseUrl });
  return { ok: true, modelCount: models.length };
}

/**
 * Streams a chat completion.
 *
 * `onDelta` is invoked with each text fragment as it arrives. The function
 * resolves with the full concatenated text once the stream ends.
 *
 * @param {object} params
 * @param {string} params.apiKey
 * @param {string} [params.baseUrl]
 * @param {string} params.model
 * @param {{role:string, content:string}[]} params.messages
 * @param {number} [params.temperature]
 * @param {(chunk:string)=>void} [params.onDelta]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{text:string, model:string, usage:object|null}>}
 */
export async function streamChat({
  apiKey,
  providerId,
  baseUrl,
  model,
  messages,
  temperature = 0.15,
  onDelta,
  signal: externalSignal,
  timeoutMs = STREAM_TIMEOUT_MS,
  idleMs = STREAM_IDLE_MS,
}) {
  if (!apiKey) throw new AiError('No API key configured.', { code: 'missing_api_key' });

  const provider = providerOrDefault(providerId);
  let attempt = 0;
  let receivedAny = false;
  // Some OpenAI-compatible servers reject the usage extension. If that is what
  // a 400 is about, the retry drops it rather than forcing the user to guess.
  let includeUsage = true;

  while (true) {
    attempt += 1;
    const deadline = withDeadline(externalSignal, timeoutMs, 'timeout', provider.label);
    const request = buildChatRequest(provider, {
      apiKey,
      baseUrl,
      model,
      messages,
      temperature,
      stream: true,
      includeUsage,
    });

    // Re-armed on every chunk: a stream that is still producing tokens is not
    // stuck, however long the complete answer takes.
    let idleTimer = null;
    let stalled = false;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        stalled = true;
        deadline.abort();
      }, idleMs);
    };

    try {
      let response;
      try {
        response = await fetch(request.url, {
          method: 'POST',
          headers: request.headers,
          signal: deadline.signal,
          body: JSON.stringify(request.body),
        });
      } catch (error) {
        if (error.name === 'AbortError') throw deadline.describe(error);
        throw new AiError(`Could not reach ${provider.label}: ${error.message}`, {
          code: 'network_error',
          retryable: true,
        });
      }

      if (!response.ok) throw await describeFailure(response, provider);
      if (!response.body) throw new AiError(`${provider.label} returned an empty response body.`, { code: 'empty_response' });

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf8');
      let buffer = '';
      let text = '';
      let usage = null;

      armIdle();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle();

        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;

            let parsed;
            try {
              parsed = JSON.parse(payload);
            } catch {
              continue; // Ignore keep-alives and partial frames.
            }

            const read = readStreamFrame(provider, { data: parsed });
            if (read.streamError) throw new AiError(read.streamError, { code: 'stream_error' });

            if (read.usage) {
              // Anthropic reports prompt and completion counts in different
              // frames, so merge rather than replace.
              usage = { ...(usage || {}), ...read.usage };
              const prompt = usage.prompt_tokens || 0;
              const completion = usage.completion_tokens || 0;
              if (prompt || completion) usage.total_tokens = prompt + completion;
            }

            if (read.delta) {
              receivedAny = true;
              text += read.delta;
              onDelta?.(read.delta);
            }
          }
        }
      }

      return { text, model, usage };
    } catch (error) {
      // A stall is its own condition: "it went quiet" and "it never answered"
      // need different advice, and the second sentence of each message says so.
      if (stalled && !deadline.timedOut()) {
        throw new AiError(
          `${provider.label} stopped sending data for ${Math.round(idleMs / 1000)}s, so the request was cancelled.`,
          { code: 'stalled', retryable: true },
        );
      }

      const described = deadline.describe(error);
      const tooLarge = described instanceof AiError && described.status === 413;

      // Two things are worth one silent retry before any text has been shown:
      // a transient upstream failure, and a request the provider rejected only
      // because of the optional usage extension.
      const usageRejected = described instanceof AiError
        && described.status === 400
        && includeUsage
        && provider.streamUsage;

      if (!receivedAny && attempt === 1 && (usageRejected || isRetryable(described)) && !tooLarge) {
        if (usageRejected) includeUsage = false;
        clearTimeout(idleTimer);
        deadline.clear();
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }

      throw described;
    } finally {
      clearTimeout(idleTimer);
      deadline.clear();
    }
  }
}

/** Transient conditions worth repeating once, without involving the user. */
function isRetryable(error) {
  return error instanceof AiError && error.retryable;
}

/**
 * Non-streaming completion, used for small internal tasks such as generating a
 * commit message where a single round trip is simpler.
 */
export async function complete({
  apiKey,
  providerId,
  baseUrl,
  model,
  messages,
  temperature = 0.2,
  maxTokens = 512,
  signal: externalSignal,
  timeoutMs = COMPLETE_TIMEOUT_MS,
}) {
  if (!apiKey) throw new AiError('No API key configured.', { code: 'missing_api_key' });

  const provider = providerOrDefault(providerId);

  for (let attempt = 1; ; attempt += 1) {
    const deadline = withDeadline(externalSignal, timeoutMs, 'timeout', provider.label);
    const request = buildChatRequest(provider, {
      apiKey,
      baseUrl,
      model,
      messages,
      temperature,
      maxTokens,
      stream: false,
    });

    try {
      let response;
      try {
        response = await fetch(request.url, {
          method: 'POST',
          headers: request.headers,
          signal: deadline.signal,
          body: JSON.stringify(request.body),
        });
      } catch (error) {
        if (error.name === 'AbortError') throw deadline.describe(error);
        throw new AiError(`Could not reach ${provider.label}: ${error.message}`, {
          code: 'network_error',
          retryable: true,
        });
      }

      if (!response.ok) throw await describeFailure(response, provider);

      const payload = await response.json();
      return {
        text: readCompletionText(provider, payload),
        usage: readCompletionUsage(provider, payload),
      };
    } catch (error) {
      const described = deadline.describe(error);
      const tooLarge = described instanceof AiError && described.status === 413;
      // A rate limit or a 5xx is worth one quiet retry; a bad key is not, and a
      // request that was simply too big will fail identically on the way back.
      if (isRetryable(described) && attempt === 1 && !tooLarge) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      throw described;
    } finally {
      deadline.clear();
    }
  }
}
