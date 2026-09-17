/**
 * HTTP client for the local GitSynapse server.
 *
 * All requests are relative URLs so the app works regardless of which port the
 * server picked, and so it never reaches out to anything but its own backend.
 */

export class ApiError extends Error {
  constructor(message, payload = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = payload.status || 0;
    this.code = payload.code || 'request_failed';
    this.hint = payload.hint || '';
    this.payload = payload;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError(
      'Cannot reach the GitSynapse server. If you opened this file directly, run `npm start` instead.',
      { code: 'server_unreachable' },
    );
  }

  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text.slice(0, 300) };
    }
  }

  if (!response.ok) {
    throw new ApiError(payload.message || `Request failed (HTTP ${response.status})`, {
      ...payload,
      status: response.status,
    });
  }

  return payload;
}

/* ------------------------------------------------------------------ *
 * Repository reading
 * ------------------------------------------------------------------ */

export const api = {
  health: () => request('/api/health'),
  systemInfo: () => request('/api/system/info'),

  fsRoots: () => request('/api/fs/roots'),
  fsList: (path) => request(`/api/fs/list?path=${encodeURIComponent(path)}`),

  openRepo: (path) => request('/api/repo/open', { method: 'POST', body: { path } }),
  status: (path) => request(`/api/repo/status?path=${encodeURIComponent(path)}`),
  log: (path, { limit = 100, skip = 0 } = {}) =>
    request(`/api/repo/log?path=${encodeURIComponent(path)}&limit=${limit}&skip=${skip}`),
  graph: (path, { limit = 150 } = {}) =>
    request(`/api/repo/graph?path=${encodeURIComponent(path)}&limit=${limit}`),
  diff: (path, { file, staged = false, commit, untracked = false } = {}) => {
    const params = new URLSearchParams({ path });
    if (file) params.set('file', file);
    if (staged) params.set('staged', 'true');
    if (commit) params.set('commit', commit);
    if (untracked) params.set('untracked', 'true');
    return request(`/api/repo/diff?${params}`);
  },
  commitDetail: (path, hash) =>
    request(`/api/repo/commit?path=${encodeURIComponent(path)}&hash=${encodeURIComponent(hash)}`),
  branches: (path) => request(`/api/repo/branches?path=${encodeURIComponent(path)}`),
  /** @returns {Promise<Array<{name:string, fetchUrl:string, pushUrl:string}>>} */
  remotes: (path) =>
    request(`/api/repo/remotes?path=${encodeURIComponent(path)}`).then((payload) => payload.remotes || []),
  stash: (path) => request(`/api/repo/stash?path=${encodeURIComponent(path)}`),
  tags: (path) => request(`/api/repo/tags?path=${encodeURIComponent(path)}`),

  /** Single write endpoint; `action` selects the operation. */
  action: (action, params = {}) => request('/api/action', { method: 'POST', body: { action, ...params } }),

  /* --- AI --- */
  aiSettings: () => request('/api/ai/settings'),
  saveAiSettings: (patch) => request('/api/ai/settings', { method: 'POST', body: patch }),
  verifyKey: (apiKey, provider) =>
    request('/api/ai/verify', { method: 'POST', body: { apiKey, provider } }),
  models: (refresh = false, provider) => {
    const params = new URLSearchParams();
    if (refresh) params.set('refresh', 'true');
    if (provider) params.set('provider', provider);
    const query = params.toString();
    return request(`/api/ai/models${query ? `?${query}` : ''}`);
  },
  sessions: () => request('/api/ai/sessions'),
  saveSession: (session) => request('/api/ai/sessions', { method: 'POST', body: { session } }),
  deleteSession: (id) => request(`/api/ai/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  runStep: (path, step, { confirmed = false, allowDestructive = false } = {}) =>
    request('/api/ai/run', { method: 'POST', body: { path, step, confirmed, allowDestructive } }),
  runPlan: (path, steps, { confirmed = false, allowDestructive = false } = {}) =>
    request('/api/ai/run-plan', { method: 'POST', body: { path, steps, confirmed, allowDestructive } }),

  commitMessage: (path) => request('/api/ai/commit-message', { method: 'POST', body: { path } }),
  /** Writes GitSynapse's standard ignore patterns for build/OS noise to .gitignore. */
  ignoreJunk: (path, patterns) =>
    request('/api/action', { method: 'POST', body: { action: 'ignoreJunk', path, patterns } }),
  explainCommit: (path, hash) => request('/api/ai/explain', { method: 'POST', body: { path, hash } }),
};

/* ------------------------------------------------------------------ *
 * Streaming chat
 * ------------------------------------------------------------------ */

/**
 * Streams a copilot turn.
 *
 * fetch + ReadableStream is used rather than EventSource because the request
 * carries a body and must be a POST.
 *
 * @param {object} params
 * @param {string} params.path          Repository path (may be empty).
 * @param {string} params.message       The user's turn.
 * @param {Array<{role:string, content:string}>} params.history
 * @param {(event:string, data:any)=>void} params.onEvent
 * @param {AbortSignal} [params.signal]
 */
export async function streamChat({
  path,
  message,
  history,
  onEvent,
  signal: externalSignal,
  idleMs = 70_000,
  totalMs = 300_000,
}) {
  // The server bounds its own work, but the renderer must not depend on that.
  // If the connection is severed without a close frame, `reader.read()` never
  // returns and the panel sits on "Thinking…" forever. Two timers, the first
  // re-armed by any progress, guarantee the turn always ends.
  const controller = new AbortController();
  let timedOut = null;

  const forward = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', forward, { once: true });
  }

  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = 'idle';
      controller.abort();
    }, idleMs);
  };

  const totalTimer = setTimeout(() => {
    timedOut = 'total';
    controller.abort();
  }, totalMs);

  const stopTimers = () => {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    externalSignal?.removeEventListener?.('abort', forward);
  };

  const timedOutError = () => new ApiError(
    timedOut === 'idle'
      ? 'The copilot stopped responding, so the request was cancelled.'
      : 'The copilot took too long and the request was cancelled.',
    { code: timedOut === 'idle' ? 'stalled' : 'timeout' },
  );

  armIdle();

  let response;
  try {
    response = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, message, history }),
      signal: controller.signal,
    });
  } catch (error) {
    stopTimers();
    if (timedOut) throw timedOutError();
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Lost connection to the GitSynapse server.', { code: 'server_unreachable' });
  }

  if (!response.ok) {
    const text = await response.text();
    let payload = {};
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text.slice(0, 300) };
    }
    throw new ApiError(payload.message || 'The copilot request failed.', {
      ...payload,
      status: response.status,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle(); // Any byte is progress, including a keep-alive comment.
      buffer += decoder.decode(value, { stream: true });

      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        let event = 'message';
        const dataLines = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;

        try {
          onEvent(event, JSON.parse(dataLines.join('\n')));
        } catch {
          // A malformed frame is dropped rather than killing the stream.
        }
      }
    }
  } catch (error) {
    if (timedOut) throw timedOutError();
    throw error;
  } finally {
    stopTimers();
  }
}
