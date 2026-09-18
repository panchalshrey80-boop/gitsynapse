/**
 * AI provider registry.
 *
 * GitSynapse talks to six different services through two wire protocols:
 *
 *   - `openai`    — the Chat Completions format (POST /chat/completions, SSE
 *                   frames with `choices[0].delta.content`). Mesh, OpenRouter,
 *                   OpenAI and Groq all speak it, so one implementation covers
 *                   four providers and the only differences are the base URL,
 *                   the auth header and a couple of optional extras.
 *   - `anthropic` — the Messages API (POST /messages, `x-api-key` instead of a
 *                   bearer token, a mandatory `max_tokens`, the system prompt as
 *                   a top-level field rather than a message, and SSE frames
 *                   shaped as `content_block_delta`).
 *
 * Nothing here is a guess about which models exist: `defaultModel` is only a
 * sensible starting point, and the Settings dialog's "Load models" button asks
 * the provider itself what the key can actually use. That matters because model
 * ids are retired regularly — an app that hard-codes one eventually fails with a
 * 404 the user cannot interpret.
 *
 * @typedef {object} Provider
 * @property {string} id                 Stable key used in config and API calls.
 * @property {string} label              Display name.
 * @property {'openai'|'anthropic'} protocol
 * @property {string} baseUrl            Default API root.
 * @property {string} defaultModel
 * @property {string[]} modelExamples    Shown as a hint under the model field.
 * @property {string} keyPrefix          How to recognise a key for this provider.
 * @property {string} keyPlaceholder     Placeholder for the key input.
 * @property {string} keyUrl             Where the user gets a key.
 * @property {string} blurb              One line, shown under the provider picker.
 * @property {boolean} [streamUsage]     Whether to ask for usage in the stream.
 * @property {Record<string,string>} [extraHeaders]
 */

/** @type {Provider[]} */
export const PROVIDERS = [
  {
    id: 'mesh',
    label: 'Mesh',
    protocol: 'openai',
    baseUrl: 'https://api.meshapi.ai/v1',
    defaultModel: 'openai/gpt-4o-mini',
    modelExamples: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-5'],
    keyPrefix: 'rsk_',
    keyPlaceholder: 'rsk_…',
    keyUrl: 'https://meshapi.ai',
    blurb: 'One key for most vendors\' models, routed through a single endpoint.',
    streamUsage: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    modelExamples: ['anthropic/claude-sonnet-5', 'openai/gpt-4o-mini', 'meta-llama/llama-3.3-70b-instruct'],
    keyPrefix: 'sk-or-',
    keyPlaceholder: 'sk-or-v1-…',
    keyUrl: 'https://openrouter.ai/keys',
    blurb: 'Aggregator with per-model pricing and broad model coverage.',
    streamUsage: true,
    // OpenRouter attributes traffic to an app using these; they are optional.
    extraHeaders: {
      'HTTP-Referer': 'https://github.com/gitsynapse',
      'X-Title': 'GitSynapse',
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    modelExamples: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    keyPrefix: 'sk-',
    keyPlaceholder: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    blurb: 'First-party OpenAI models.',
    streamUsage: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    // Claude 3.5 ids are retired; these are current aliases at the time of
    // writing, and "Load models" shows what the key can actually reach.
    defaultModel: 'claude-sonnet-5',
    modelExamples: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'],
    keyPrefix: 'sk-ant-',
    keyPlaceholder: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    blurb: 'Claude models. Uses Anthropic\'s own Messages API, not the OpenAI format.',
    extraHeaders: {
      'anthropic-version': '2023-06-01',
    },
  },
  {
    id: 'groq',
    label: 'Groq',
    protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    // Groq retired its Llama 3.x models in August 2026 and recommends the
    // GPT-OSS family instead; older ids still resolve on some accounts but are
    // not what a new install should be pointed at.
    defaultModel: 'openai/gpt-oss-120b',
    modelExamples: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    keyPrefix: 'gsk_',
    keyPlaceholder: 'gsk_…',
    keyUrl: 'https://console.groq.com/keys',
    blurb: 'Very fast inference on open-weight models.',
    streamUsage: true,
  },
];

/** Mesh stays the default so existing installations keep working unchanged. */
export const DEFAULT_PROVIDER_ID = 'mesh';

/** Anthropic refuses a request without this. */
const ANTHROPIC_MAX_TOKENS = 4096;

/** @returns {Provider|undefined} */
export function findProvider(id) {
  return PROVIDERS.find((provider) => provider.id === id);
}

/**
 * Resolves a provider id, falling back to the default rather than throwing.
 * A config file naming a provider this build does not know about (a downgrade,
 * a hand-edited file) must not brick the copilot.
 *
 * @param {string} [id]
 * @returns {Provider}
 */
export function providerOrDefault(id) {
  return findProvider(id) || findProvider(DEFAULT_PROVIDER_ID);
}

/** Renderer-safe provider description — no secrets, just what the UI needs. */
export function providerSummaries() {
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    protocol: provider.protocol,
    defaultModel: provider.defaultModel,
    modelExamples: provider.modelExamples,
    keyPlaceholder: provider.keyPlaceholder,
    keyPrefix: provider.keyPrefix,
    keyUrl: provider.keyUrl,
    blurb: provider.blurb,
    baseUrl: provider.baseUrl,
  }));
}

/** The base URL actually used: a configured override wins over the default. */
export function baseUrlFor(provider, override) {
  const candidate = (override || provider.baseUrl || '').trim().replace(/\/+$/, '');
  if (!candidate) return provider.baseUrl;
  // Tolerate a base URL typed without its version segment.
  return /\/v\d+$/.test(candidate) ? candidate : `${candidate}/v1`;
}

/**
 * Splits our flat message list into what the Anthropic Messages API expects.
 *
 * Two rules are not optional there: the system prompt is a top-level field
 * rather than a message, and the conversation must alternate user/assistant
 * starting with a user turn. Our history can violate the second one whenever a
 * turn was dropped (an empty reply, a filtered string), so consecutive turns of
 * the same role are merged instead of being sent to be rejected.
 *
 * @param {Array<{role:string, content:string}>} messages
 * @returns {{system:string, messages:Array<{role:string, content:string}>}}
 */
export function toAnthropicMessages(messages) {
  const system = [];
  const turns = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message.content !== 'string') continue;
    if (message.role === 'system') {
      if (message.content.trim()) system.push(message.content);
      continue;
    }
    if (!['user', 'assistant'].includes(message.role)) continue;

    const last = turns[turns.length - 1];
    if (last && last.role === message.role) last.content += `\n\n${message.content}`;
    else turns.push({ role: message.role, content: message.content });
  }

  // The API rejects a conversation that begins with an assistant turn, which can
  // happen if the history window starts mid-exchange.
  while (turns.length > 0 && turns[0].role !== 'user') turns.shift();

  return { system: system.join('\n\n'), messages: turns };
}

/**
 * Builds the HTTP request for one chat turn.
 *
 * @param {Provider} provider
 * @param {object} params
 * @param {string} params.apiKey
 * @param {string} [params.baseUrl]   Override, mainly for tests and proxies.
 * @param {string} params.model
 * @param {Array<{role:string, content:string}>} params.messages
 * @param {number} params.temperature
 * @param {number} [params.maxTokens]
 * @param {boolean} params.stream
 * @param {boolean} [params.includeUsage]
 * @returns {{url:string, headers:Record<string,string>, body:object}}
 */
export function buildChatRequest(provider, {
  apiKey,
  baseUrl,
  model,
  messages,
  temperature,
  maxTokens,
  stream,
  includeUsage = true,
}) {
  const root = baseUrlFor(provider, baseUrl);
  const modelId = (model || provider.defaultModel).trim();

  if (provider.protocol === 'anthropic') {
    const { system, messages: turns } = toAnthropicMessages(messages);
    const body = {
      model: modelId,
      // Required by the Messages API — omitting it is an immediate 400.
      max_tokens: maxTokens || ANTHROPIC_MAX_TOKENS,
      messages: turns,
      temperature,
      stream,
    };
    if (system) body.system = system;

    return {
      url: `${root}/messages`,
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        ...(provider.extraHeaders || {}),
      },
      body,
    };
  }

  const body = {
    model: modelId,
    messages,
    temperature,
    stream,
  };
  if (maxTokens) body.max_tokens = maxTokens;
  // Usage accounting is an OpenAI extension some compatible servers reject.
  if (stream && includeUsage && provider.streamUsage) {
    body.stream_options = { include_usage: true };
  }

  return {
    url: `${root}/chat/completions`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(provider.extraHeaders || {}),
    },
    body,
  };
}

/** @returns {{url:string, headers:Record<string,string>}} */
export function buildModelsRequest(provider, { apiKey, baseUrl }) {
  const root = baseUrlFor(provider, baseUrl);
  if (provider.protocol === 'anthropic') {
    return {
      url: `${root}/models`,
      headers: {
        'x-api-key': apiKey,
        ...(provider.extraHeaders || {}),
      },
    };
  }
  return {
    url: `${root}/models`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(provider.extraHeaders || {}),
    },
  };
}

/**
 * Extracts the incremental text (and any usage) from one parsed SSE payload.
 *
 * Returns an empty object for frames that carry neither, so the caller can
 * treat every provider the same way.
 *
 * @param {Provider} provider
 * @param {{event?:string, data:any}} frame
 * @returns {{delta?:string, usage?:object|null, stopReason?:string}}
 */
export function readStreamFrame(provider, frame) {
  const data = frame?.data;
  if (!data || typeof data !== 'object') return {};

  if (provider.protocol === 'anthropic') {
    switch (data.type) {
      case 'content_block_delta': {
        const text = data.delta?.text;
        return typeof text === 'string' && text.length > 0 ? { delta: text } : {};
      }
      case 'message_start': {
        const input = data.message?.usage?.input_tokens;
        return input ? { usage: { prompt_tokens: input, total_tokens: input } } : {};
      }
      case 'message_delta': {
        const output = data.usage?.output_tokens;
        return output ? { usage: { completion_tokens: output } } : {};
      }
      case 'error':
        return { streamError: data.error?.message || 'The provider reported a stream error.' };
      default:
        return {};
    }
  }

  const choice = data.choices?.[0];
  const out = {};
  const fragment = choice?.delta?.content;
  if (typeof fragment === 'string' && fragment.length > 0) out.delta = fragment;
  if (data.usage) out.usage = data.usage;
  if (choice?.finish_reason) out.stopReason = choice.finish_reason;
  return out;
}

/** Extracts the text from a non-streaming reply. */
export function readCompletionText(provider, payload) {
  if (provider.protocol === 'anthropic') {
    const blocks = Array.isArray(payload?.content) ? payload.content : [];
    return blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
  }
  const content = payload?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

/** Usage figures differ in shape between the two protocols. */
export function readCompletionUsage(provider, payload) {
  if (provider.protocol === 'anthropic') {
    const usage = payload?.usage;
    if (!usage) return null;
    const prompt = usage.input_tokens || 0;
    const completion = usage.output_tokens || 0;
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    };
  }
  return payload?.usage || null;
}
