/**
 * AI copilot routes.
 *
 * The chat endpoint streams over Server-Sent Events: prose arrives as `text`
 * events, and the machine-readable plan arrives once as a `plan` event after
 * the model finishes. Streaming is what makes the panel feel like a chat rather
 * than a form submission, and it keeps the UI responsive on long answers.
 */

import express from 'express';
import { AiError, complete, listModels, streamChat, verifyKey } from '../ai/client.js';
import { SYSTEM_PROMPT, buildRepoContext, createPlanExtractor } from '../ai/agent.js';
import { executePlan, executeStep } from '../git/executor.js';
import { findRepositoryRoot, getDiff, getLog, getRemotes, getStatus } from '../git/repository.js';
import { runGitIn } from '../git/runner.js';
import { sanitizeText, sanitizeTurns } from '../ai/text.js';
import { findProvider, providerOrDefault } from '../ai/providers.js';
import {
  getApiKey, getBaseUrlOverride, loadConfig, publicSettings, saveConfig,
  saveSession, loadSessions, deleteSession, setApiKey,
} from '../store.js';
import { asyncRoute } from './repo.js';

export const aiRouter = express.Router();

const MAX_MESSAGE_CHARS = 4_000;
const MAX_HISTORY_TURNS = 10;
const MAX_DIFF_CHARS = 14_000;

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

aiRouter.get('/ai/settings', (req, res) => {
  res.json(publicSettings());
});

aiRouter.post('/ai/settings', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const patch = {};

  // Switching provider is allowed alongside writing a key; the key is filed
  // under whichever provider is in force *after* the switch, so
  // {provider:'groq', apiKey:'gsk_…'} does what it looks like.
  const requestedProvider = typeof body.provider === 'string' ? body.provider.trim() : '';
  if (requestedProvider) {
    if (!findProvider(requestedProvider)) {
      res.status(400).json({
        error: 'unknown_provider',
        message: `"${requestedProvider}" is not a provider this build knows about.`,
      });
      return;
    }
    patch.provider = requestedProvider;
  }

  const activeProvider = patch.provider || loadConfig().provider;

  if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') {
    setApiKey(body.apiKey, activeProvider);
  }
  // Clearing is per provider: it must not wipe the other providers' keys.
  if (body.clearApiKey === true) setApiKey('', activeProvider);

  // A base URL override applies to one provider only, so pointing the mock
  // server at Mesh in a test cannot silently redirect a real OpenAI key later.
  if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
    const overrides = { ...(loadConfig().baseUrlOverrides || {}) };
    overrides[activeProvider] = body.baseUrl.trim();
    patch.baseUrlOverrides = overrides;
  }
  if (typeof body.clearBaseUrl === 'boolean' && body.clearBaseUrl) {
    const overrides = { ...(loadConfig().baseUrlOverrides || {}) };
    delete overrides[activeProvider];
    patch.baseUrlOverrides = overrides;
    if (activeProvider === loadConfig().provider) patch.baseUrl = null;
  }

  if (typeof body.model === 'string' && body.model.trim()) patch.model = body.model.trim();

  // When the provider changes and no model was given, fall back to that
  // provider's default rather than leaving the previous vendor's model id in
  // place — which would 404 on the first message.
  if (patch.provider && !patch.model && !(typeof body.model === 'string' && body.model.trim())) {
    const previous = loadConfig().provider;
    if (previous !== patch.provider) patch.model = findProvider(patch.provider).defaultModel;
  }
  if (['all', 'destructive', 'never'].includes(body.confirmPolicy)) patch.confirmPolicy = body.confirmPolicy;
  if (typeof body.autoRunReadOnly === 'boolean') patch.autoRunReadOnly = body.autoRunReadOnly;
  if (typeof body.aiEnabled === 'boolean') patch.aiEnabled = body.aiEnabled;
  if (typeof body.showRawOutput === 'boolean') patch.showRawOutput = body.showRawOutput;

  if (Object.keys(patch).length > 0) saveConfig(patch);

  res.json({ ok: true, settings: publicSettings() });
}));

aiRouter.post('/ai/verify', asyncRoute(async (req, res) => {
  const provider = providerOrDefault(req.body?.provider || loadConfig().provider);
  const apiKey = req.body?.apiKey?.trim() || getApiKey(provider.id);

  if (!apiKey) {
    res.status(400).json({
      error: 'missing_api_key',
      message: `Enter your ${provider.label} API key first.`,
    });
    return;
  }

  try {
    const result = await verifyKey({
      apiKey,
      providerId: provider.id,
      baseUrl: req.body?.baseUrl || getBaseUrlOverride(provider.id),
    });
    res.json({ ok: true, modelCount: result.modelCount });
  } catch (error) {
    res.status(error.status || 502).json({
      error: error.code || 'verify_failed',
      message: error.message,
      hint: error.code === 'network_error'
        ? 'Check your internet connection or proxy settings.'
        : undefined,
    });
  }
}));

aiRouter.get('/ai/models', asyncRoute(async (req, res) => {
  const config = loadConfig();
  const provider = providerOrDefault(req.query.provider || config.provider);
  const apiKey = getApiKey(provider.id);

  if (!apiKey) {
    res.status(400).json({
      error: 'missing_api_key',
      message: `Save your ${provider.label} API key first.`,
    });
    return;
  }

  const cache = config.modelsCache?.[provider.id] || [];
  if (req.query.refresh !== 'true' && cache.length > 0) {
    res.json({ models: cache, cached: true, provider: provider.id });
    return;
  }

  try {
    const models = await listModels({
      apiKey,
      providerId: provider.id,
      baseUrl: getBaseUrlOverride(provider.id),
    });
    // Keep the cache small: some catalogues run to four figures, and the whole
    // list is stored per provider so switching back does not refetch.
    const trimmed = models.slice(0, 600);
    saveConfig({ modelsCache: { ...(config.modelsCache || {}), [provider.id]: trimmed } });
    res.json({ models: trimmed, cached: false, provider: provider.id });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.code || 'models_failed', message: error.message });
  }
}));

/* ------------------------------------------------------------------ *
 * Session history
 * ------------------------------------------------------------------ */

aiRouter.get('/ai/sessions', (req, res) => {
  res.json({ sessions: loadSessions() });
});

aiRouter.post('/ai/sessions', asyncRoute(async (req, res) => {
  const session = req.body?.session;
  if (!session || typeof session.id !== 'string') {
    res.status(400).json({ error: 'invalid_session', message: 'A session object with an id is required.' });
    return;
  }
  res.json({ ok: true, sessions: saveSession(session) });
}));

aiRouter.delete('/ai/sessions/:id', (req, res) => {
  res.json({ ok: true, sessions: deleteSession(req.params.id) });
});

/* ------------------------------------------------------------------ *
 * Chat
 * ------------------------------------------------------------------ */

/**
 * Gathers the repository facts the model is allowed to see.
 * Only names, refs and statuses are sent — never file contents, except when the
 * user explicitly asks for a commit message from a diff.
 */
async function gatherContext(repoPath) {
  if (!repoPath) return { context: buildRepoContext(null), status: null };

  const found = findRepositoryRoot(repoPath);
  if (!found) return { context: buildRepoContext(null), status: null };

  const [status, remotes, commits] = await Promise.all([
    getStatus(found.root),
    getRemotes(found.root),
    getLog(found.root, { limit: 8 }),
  ]);

  const context = buildRepoContext(status, {
    remotes: remotes.map((remote) => remote.name),
    recentCommits: commits.map((commit) => `${commit.short} ${commit.subject}`),
  });

  return { context, status };
}

aiRouter.post('/ai/chat', asyncRoute(async (req, res) => {
  const config = loadConfig();
  const provider = providerOrDefault(config.provider);
  const apiKey = getApiKey(provider.id);

  if (!config.aiEnabled) {
    res.status(503).json({ error: 'ai_disabled', message: 'The AI copilot is switched off in Settings.' });
    return;
  }
  if (!apiKey) {
    res.status(400).json({
      error: 'missing_api_key',
      message: `No ${provider.label} API key is saved yet. Open Settings and paste your key.`,
    });
    return;
  }

  const message = sanitizeText(req.body?.message, { maxChars: MAX_MESSAGE_CHARS }).trim();
  if (!message) {
    res.status(400).json({ error: 'empty_message', message: 'Type what you want to do.' });
    return;
  }

  const repoPath = req.body?.path ? String(req.body.path) : null;
  const { context, status } = await gatherContext(repoPath);

  // History arrives from the renderer, where it was assembled from command
  // output. It is re-validated here: unparseable entries would otherwise make
  // every subsequent request fail identically, which reads as a stuck copilot.
  const priorTurns = sanitizeTurns(req.body?.history, {
    maxChars: 6_000,
    limit: MAX_HISTORY_TURNS,
  });

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: sanitizeText(context, { maxChars: 20_000 }) },
    ...priorTurns,
    { role: 'user', content: sanitizeText(message, { maxChars: MAX_MESSAGE_CHARS }) },
  ];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  // A browser that closes the tab mid-answer leaves a socket that throws on
  // write. Without a listener that becomes an unhandled 'error' event, which
  // takes the whole server process down.
  res.on('error', () => controller.abort());
  req.socket?.on('error', () => controller.abort());

  let terminal = false;

  const send = (event, data) => {
    if (event === 'done' || event === 'error') terminal = true;
    if (res.writableEnded || res.destroyed || !res.writable) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // The client went away mid-frame; the answer is no longer deliverable.
      controller.abort();
    }
  };

  const extractor = createPlanExtractor();

  try {
    send('meta', { model: config.model || provider.defaultModel, provider: provider.label, hasRepo: Boolean(status) });

    const { usage } = await streamChat({
      apiKey,
      providerId: provider.id,
      baseUrl: getBaseUrlOverride(provider.id),
      model: config.model || provider.defaultModel,
      messages,
      onDelta: (chunk) => {
        const visible = extractor.push(chunk);
        if (visible) send('text', { delta: visible });
      },
      signal: controller.signal,
    });

    const { reply, plan, leftover } = extractor.finish();

    // The extractor holds back a few characters while it checks for a plan
    // fence, and when no fence arrives those characters are still in hand. They
    // are real prose, so they are emitted here — otherwise every reply that
    // does not end in a plan loses its last few characters on screen.
    if (leftover) send('text', { delta: leftover });

    const blockedSteps = plan ? plan.steps.filter((step) => !step.allowed) : [];

    send('plan', {
      reply,
      plan: plan
        ? {
            summary: plan.summary,
            steps: plan.steps,
            blockedCount: blockedSteps.length,
          }
        : null,
      usage: usage || null,
    });
    send('done', { ok: true });
  } catch (error) {
    if (error.name === 'AbortError') {
      send('done', { ok: false, aborted: true });
    } else if (error instanceof AiError) {
      send('error', {
        error: error.code,
        message: error.message,
        hint: error.retryable ? 'This is usually temporary. Try again in a moment.' : undefined,
      });
    } else {
      send('error', { error: 'unexpected', message: error.message });
    }
  } finally {
    // Every path ends with a terminal event. A stream that simply stops leaves
    // the renderer showing "Thinking…" with nothing to react to, which is the
    // difference between a slow answer and an app that looks broken.
    if (!terminal) send('done', { ok: false, aborted: true });
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        // Already closed by the client.
      }
    }
  }
}));

/* ------------------------------------------------------------------ *
 * Execution of AI-proposed commands
 * ------------------------------------------------------------------ */

aiRouter.post('/ai/run', asyncRoute(async (req, res) => {
  const repoPath = String(req.body?.path || '');
  const found = findRepositoryRoot(repoPath);
  if (!found) {
    res.status(404).json({ error: 'not_a_repository', message: 'Open a repository before running commands.' });
    return;
  }

  const step = req.body?.step;
  const confirmed = Boolean(req.body?.confirmed);
  // Set by the UI only after a dialog that named the exact command.
  const allowDestructive = Boolean(req.body?.allowDestructive);

  const outcome = await executeStep(found.root, step, { confirmed, allowDestructive });

  if (outcome.status === 'needs_confirmation') {
    res.json({
      status: 'needs_confirmation',
      command: `git ${step?.args?.join(' ') ?? ''}`,
      risk: outcome.verdict.level,
      reasons: outcome.verdict.reasons,
    });
    return;
  }

  if (outcome.status === 'blocked') {
    res.status(403).json({ status: 'blocked', error: 'blocked_command', message: outcome.reason });
    return;
  }

  const status = await getStatus(found.root);

  res.json({
    status: outcome.status,
    command: outcome.result?.command,
    stdout: outcome.result?.stdout ?? '',
    stderr: outcome.result?.stderr ?? '',
    exitCode: outcome.result?.code ?? null,
    durationMs: outcome.result?.durationMs ?? 0,
    risk: outcome.verdict?.level,
    reason: outcome.reason,
    statusAfter: status,
  });
}));

aiRouter.post('/ai/run-plan', asyncRoute(async (req, res) => {
  const repoPath = String(req.body?.path || '');
  const found = findRepositoryRoot(repoPath);
  if (!found) {
    res.status(404).json({ error: 'not_a_repository', message: 'Open a repository before running commands.' });
    return;
  }

  const steps = Array.isArray(req.body?.steps) ? req.body.steps.slice(0, 8) : [];
  if (steps.length === 0) {
    res.status(400).json({ error: 'empty_plan', message: 'There is nothing to run.' });
    return;
  }

  const outcome = await executePlan(found.root, steps, {
    confirmed: Boolean(req.body?.confirmed),
    allowDestructive: Boolean(req.body?.allowDestructive),
  });

  const status = await getStatus(found.root);

  res.json({
    completed: outcome.completed,
    executed: outcome.executed.map((entry) => ({
      command: entry.step?.display || `git ${(entry.step?.args || []).join(' ')}`,
      status: entry.outcome.status,
      stdout: entry.outcome.result?.stdout ?? '',
      stderr: entry.outcome.result?.stderr ?? '',
      exitCode: entry.outcome.result?.code ?? null,
      reason: entry.outcome.reason,
      risk: entry.outcome.verdict?.level,
    })),
    statusAfter: status,
  });
}));

/* ------------------------------------------------------------------ *
 * Focused AI helpers
 * ------------------------------------------------------------------ */

/** Drafts a commit message from the staged diff. */
aiRouter.post('/ai/commit-message', asyncRoute(async (req, res) => {
  const config = loadConfig();
  const provider = providerOrDefault(config.provider);
  const apiKey = getApiKey(provider.id);

  if (!apiKey) {
    res.status(400).json({
      error: 'missing_api_key',
      message: `Save your ${provider.label} API key first.`,
    });
    return;
  }

  const found = findRepositoryRoot(String(req.body?.path || ''));
  if (!found) {
    res.status(404).json({ error: 'not_a_repository', message: 'Open a repository first.' });
    return;
  }

  const status = await getStatus(found.root);
  const hasStaged = status.stagedCount > 0;

  const diff = await getDiff(found.root, { staged: hasStaged });
  const source = sanitizeText(diff.raw, { maxChars: MAX_DIFF_CHARS });

  if (!source.trim()) {
    res.status(400).json({ error: 'nothing_to_summarise', message: 'Stage some changes first.' });
    return;
  }

  // Include file names even when the diff itself is truncated.
  const fileList = status.files
    .filter((file) => (hasStaged ? file.staged : file.unstaged || file.untracked))
    .map((file) => `${file.index}${file.worktree} ${sanitizeText(file.path, { maxChars: 300 })}`)
    .slice(0, 60)
    .join('\n');

  try {
    const { text } = await complete({
      apiKey,
      providerId: provider.id,
      baseUrl: getBaseUrlOverride(provider.id),
      model: config.model || provider.defaultModel,
      temperature: 0.1,
      maxTokens: 300,
      messages: [
        {
          role: 'system',
          content:
            'You write git commit messages. Reply with the subject line first, then a blank line, then optional bullet points. ' +
            'Use imperative mood ("add", "fix", "refactor"). Subject line under 72 characters, no trailing period, no quotes. ' +
            'Do not explain your reasoning, do not add a preamble, do not wrap the answer in code fences.',
        },
        {
          role: 'user',
          content: `Staged files:\n${fileList}\n\nDiff:\n${source}`,
        },
      ],
    });

    res.json({ ok: true, message: text.trim(), stagedOnly: hasStaged, files: fileList });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.code || 'generation_failed', message: error.message });
  }
}));

/** Explains a commit in plain language, for the history view. */
aiRouter.post('/ai/explain', asyncRoute(async (req, res) => {
  const config = loadConfig();
  const provider = providerOrDefault(config.provider);
  const apiKey = getApiKey(provider.id);

  if (!apiKey) {
    res.status(400).json({
      error: 'missing_api_key',
      message: `Save your ${provider.label} API key first.`,
    });
    return;
  }

  const found = findRepositoryRoot(String(req.body?.path || ''));
  if (!found) {
    res.status(404).json({ error: 'not_a_repository', message: 'Open a repository first.' });
    return;
  }

  const hash = String(req.body?.hash || '');
  if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) {
    res.status(400).json({ error: 'bad_hash', message: 'A valid commit hash is required.' });
    return;
  }

  const diff = await runGitIn(found.root, ['show', '--stat', '--patch', '--no-color', hash]);
  const source = sanitizeText(diff.stdout, { maxChars: MAX_DIFF_CHARS });

  if (!source.trim()) {
    res.status(404).json({ error: 'commit_not_found', message: 'That commit could not be read.' });
    return;
  }

  try {
    const { text } = await complete({
      apiKey,
      providerId: provider.id,
      baseUrl: getBaseUrlOverride(provider.id),
      model: config.model || provider.defaultModel,
      temperature: 0.2,
      maxTokens: 500,
      messages: [
        {
          role: 'system',
          content:
            'You explain git commits to a developer who is new to Git. ' +
            'Give 2-4 short sentences: what changed, why it likely mattered, and any risk or follow-up. ' +
            'Plain prose, no headings, no bullet lists, no code fences.',
        },
        { role: 'user', content: source },
      ],
    });

    res.json({ ok: true, explanation: text.trim() });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.code || 'generation_failed', message: error.message });
  }
}));
