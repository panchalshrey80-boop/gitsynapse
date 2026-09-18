/**
 * Copilot panel.
 *
 * Flow for a turn:
 *   1. The user describes an intent in plain language.
 *   2. The reply streams in as prose; the trailing plan block is stripped out
 *      server-side and delivered separately as a `plan` event.
 *   3. The plan renders as a card of steps, each labelled with the risk the
 *      *server* computed — never the risk the model claimed.
 *   4. Nothing executes until the user approves it, and the approval sheet
 *      shows the exact command that will run.
 */

import { api, ApiError, streamChat } from './api.js';
import { state, setState } from './state.js';
import {
  appendAll, confirmDialog, copyText, formatDuration, h, mount, riskBadge, toast,
} from './ui.js';
import { renderMarkdown } from './markdown.js';

const elements = {};
const transcript = [];
let sessionId = null;
let activeController = null;
let streaming = false;
let onRepositoryChanged = () => {};

export function initChat({ onRepoChange } = {}) {
  elements.log = document.getElementById('chat-log');
  elements.input = document.getElementById('chat-input');
  elements.send = document.getElementById('btn-send');
  elements.hint = document.getElementById('composer-hint');
  elements.modelPill = document.getElementById('model-pill');
  elements.newChat = document.getElementById('btn-new-chat');

  if (onRepoChange) onRepositoryChanged = onRepoChange;

  elements.input?.addEventListener('input', autoGrow);
  elements.input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  elements.send?.addEventListener('click', () => send());
  elements.newChat?.addEventListener('click', () => resetConversation());

  document.querySelectorAll('.chip[data-prompt]').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (!elements.input) return;
      elements.input.value = chip.dataset.prompt || '';
      autoGrow();
      elements.input.focus();
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && streaming && activeController) activeController.abort();
  });

  renderEmpty();
  updateModelPill();
}

function autoGrow() {
  const input = elements.input;
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  updateSendState();
}

function updateSendState() {
  if (!elements.send) return;
  const hasText = (elements.input?.value || '').trim().length > 0;
  elements.send.disabled = streaming || !hasText;
}

export function updateModelPill() {
  const pill = elements.modelPill;
  if (!pill) return;
  pill.textContent = state.settings?.model || 'no model';
  pill.title = state.settings?.hasApiKey
    ? `${state.settings.providerLabel || 'AI'} · ${state.settings.model}`
    : 'No API key saved — open Settings';
}

/* ------------------------------------------------------------------ *
 * Transcript
 * ------------------------------------------------------------------ */

function scrollToBottom() {
  const log = elements.log;
  if (!log) return;
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}

function renderEmpty() {
  if (!elements.log) return;

  const suggestions = [
    'Show me what changed and what to do next',
    'Undo my last commit but keep the changes',
    'Create a branch for this work and push it',
    'Why would my push be rejected?',
  ];

  const ready = state.settings?.hasApiKey;

  mount(elements.log, h('div.chat-empty', {}, [
    h('div.chat-empty__title', { text: ready ? 'Describe the outcome you want' : 'Add an API key to use the copilot' }),
    h('div.chat-empty__body', {
      text: ready
        ? 'The copilot reads your branch, staged files and recent commits, then proposes exact git commands. You approve each one before it runs.'
        : 'Everything else in GitSynapse works without one — this only affects the copilot.',
    }),
    ready
      ? h('div.chat-empty__list', {}, suggestions.map((text) => h('button.suggestion', {
          type: 'button',
          onClick: () => {
            elements.input.value = text;
            autoGrow();
            elements.input.focus();
          },
        }, [
          h('span.suggestion__arrow', { text: '›' }),
          h('span', { text }),
        ])))
      : h('div', {}, [
          h('button.btn.btn--primary', {
            type: 'button',
            text: 'Open Settings',
            onClick: () => document.getElementById('btn-settings')?.click(),
          }),
        ]),
  ]));
}

function appendUserMessage(text) {
  if (!elements.log) return;
  elements.log.querySelector('.chat-empty')?.remove();
  elements.log.append(h('div.msg.msg--user', {}, [h('div.msg__bubble', { text })]));
  scrollToBottom();
}

function appendAssistantMessage() {
  const body = h('div.msg__body');
  const caret = h('span.caret');
  body.append(caret);

  const note = h('div.msg__note');
  const message = h('div.msg.msg--assistant', {}, [body, note]);

  elements.log?.append(message);
  scrollToBottom();

  return { message, body, caret, note };
}

/* ------------------------------------------------------------------ *
 * Sending a turn
 * ------------------------------------------------------------------ */

export function send(explicitText) {
  const input = elements.input;
  const text = (explicitText ?? input?.value ?? '').trim();
  if (!text || streaming) return;

  if (!state.settings?.hasApiKey) {
    toast({
      kind: 'warn',
      title: 'No API key',
      body: 'Open Settings, pick a provider and paste your key to use the copilot.',
    });
    return;
  }

  if (input) {
    input.value = '';
    autoGrow();
  }

  appendUserMessage(text);
  transcript.push({ role: 'user', content: text });

  const { body, caret, note } = appendAssistantMessage();
  let received = '';
  let handledPlan = false;
  let concluded = false;

  streaming = true;
  updateSendState();
  setHint('Thinking…');
  activeController = new AbortController();

  const stopCaret = () => { if (caret.isConnected) caret.remove(); };

  streamChat({
    path: state.repoPath || '',
    message: text,
    history: transcript.slice(-12),
    signal: activeController.signal,
    onEvent: (event, data) => {
      if (event === 'text') {
        if (!received) stopCaret();
        received += data.delta;
        body.append(document.createTextNode(data.delta));
        scrollToBottom();
        return;
      }

      if (event === 'plan') {
        handledPlan = true;
        stopCaret();

        // Prose was already streamed. Only render it from the event payload if
        // nothing arrived over the text channel (some models answer in one go).
        if (!received && data.reply) body.append(...renderMarkdown(data.reply).childNodes);

        const plan = data.plan;
        if (plan && plan.steps.length > 0) {
          body.append(renderPlan(plan, { onExecuted: onRepositoryChanged }));
        } else if (plan) {
          note.append(h('span', { text: 'No commands needed — nothing to run.' }));
        }

        if (data.usage?.total_tokens) {
          note.append(h('span.dim', { text: `${data.usage.total_tokens} tokens` }));
        }

        const replyText = (data.reply || received || '').replace(/```gitplan[\s\S]*$/m, '').trim();
        if (replyText) transcript.push({ role: 'assistant', content: replyText });
        return;
      }

      if (event === 'error') {
        concluded = true;
        stopCaret();
        showError(body, note, data);
        return;
      }

      if (event === 'done') {
        concluded = true;
        stopCaret();
        if (!handledPlan && received) body.append(...renderMarkdown(received).childNodes);
      }
    },
  })
    .catch((error) => {
      concluded = true;
      stopCaret();

      if (error.name === 'AbortError') {
        note.append(h('span', { text: 'Stopped.' }));
        return;
      }

      showError(body, note, {
        message: error instanceof ApiError ? error.message : String(error.message || error),
        error: error.code,
        hint: error.hint,
      });
    })
    .finally(() => {
      // A stream can end without ever sending a verdict — the server restarted,
      // the socket was cut, an intermediate proxy closed the connection. The
      // turn must still come to rest, with something the user can act on,
      // rather than leaving a caret blinking against a disabled send button.
      if (!concluded) {
        stopCaret();
        showError(body, note, {
          message: received
            ? 'The reply stopped part-way through.'
            : 'The copilot did not answer.',
          hint: 'Check your connection and the API key in Settings, then try again.',
        });
      }

      streaming = false;
      activeController = null;
      setHint('Enter to send · Shift+Enter for a new line');
      updateSendState();
      persistSession();
      scrollToBottom();
    });
}

function setHint(text) {
  if (elements.hint) elements.hint.textContent = text;
}

function showError(body, note, data) {
  if (!body.querySelector('.msg__note--error')) {
    body.append(h('div.msg__note.msg__note--error', { text: data.message || 'The request failed.' }));
  }
  if (data.hint) note.append(h('span', { text: data.hint }));

  if (['missing_api_key', 'invalid_api_key'].includes(data.error)) {
    note.append(h('button.btn.btn--small', {
      type: 'button',
      text: 'Open Settings',
      onClick: () => document.getElementById('btn-settings')?.click(),
    }));
  }

  if (data.error === 'rate_limited') note.append(h('span', { text: 'Wait a moment, then resend.' }));
  scrollToBottom();
}

/* ------------------------------------------------------------------ *
 * Plan card
 * ------------------------------------------------------------------ */

/**
 * @param {{summary:string, steps:object[], blockedCount:number}} plan
 * @param {{onExecuted:Function}} context
 * @returns {HTMLElement}
 */
function renderPlan(plan, context) {
  const steps = plan.steps || [];
  const hasBlocked = steps.some((step) => !step.allowed);
  const runnable = steps.filter((step) => step.allowed);

  const card = h(`div.plan${hasBlocked ? '.plan--blocked' : ''}`, {}, [
    h('div.plan__head', {}, [
      h('span.plan__label', { text: 'Proposed' }),
      h('span.plan__summary', {
        text: plan.summary || `${steps.length} step${steps.length === 1 ? '' : 's'}`,
      }),
    ]),
  ]);

  const stepList = h('div.plan__steps');
  const stepNodes = steps.map((step, index) => renderStep(step, index, {
    onExecuted: context.onExecuted,
  }));
  for (const node of stepNodes) stepList.append(node);
  card.append(stepList);

  if (hasBlocked) {
    card.append(h('div.plan__foot', {}, [
      h('span.plan__label', { text: 'blocked' }),
      h('span.msg__note.msg__note--error', {
        text: 'A step was refused by the safety layer. Run it manually in Git Bash if you are certain it is safe.',
      }),
    ]));
    return card;
  }

  const runAll = h('button.btn.btn--primary.btn--small', {
    type: 'button',
    text: runnable.length === 1 ? 'Run' : `Run all ${runnable.length}`,
  });

  runAll.addEventListener('click', async () => {
    const approved = await approve({
      title: 'Run this plan?',
      sub: 'These commands run in order, top to bottom, against your repository.',
      steps: runnable,
      confirmLabel: `Run ${runnable.length} command${runnable.length === 1 ? '' : 's'}`,
      danger: runnable.some((step) => step.risk === 'destructive'),
    });
    if (!approved) return;

    runAll.disabled = true;
    runAll.textContent = 'Running…';

    try {
      // The sheet above listed every command and its risk, so approval covers
      // destructive steps too — but the server still requires the flag.
      const result = await api.runPlan(state.repoPath, runnable, {
        confirmed: true,
        allowDestructive: runnable.some((step) => step.risk === 'destructive'),
      });

      result.executed.forEach((entry, index) => {
        const node = stepNodes[steps.indexOf(runnable[index])];
        if (node) applyOutcome(node, entry, entry.status === 'ran' ? 'done' : 'failed');
      });

      if (result.completed) {
        toast({ kind: 'ok', title: 'Plan completed', body: `${result.executed.length} command(s) ran successfully.` });
      } else {
        const failed = result.executed.find((entry) => entry.status !== 'ran');
        toast({
          kind: 'warn',
          title: 'Plan stopped early',
          body: failed?.reason || 'A command did not complete. Review the output above.',
        });
      }
      context.onExecuted?.();
    } catch (error) {
      toast({ kind: 'error', title: 'Could not run the plan', body: error.message });
    } finally {
      runAll.disabled = false;
      runAll.textContent = runnable.length === 1 ? 'Run' : `Run all ${runnable.length}`;
    }
  });

  card.append(h('div.plan__foot', {}, [
    runAll,
    h('span.plan__label', { text: 'nothing runs until you approve' }),
  ]));

  return card;
}

function renderStep(step, index, context) {
  const node = h(`div.step${step.allowed ? '' : '.is-blocked'}`, {
    dataset: { index: String(index) },
  });

  const runButton = h('button.btn.btn--small', {
    type: 'button',
    text: step.allowed ? 'Run' : 'Blocked',
    disabled: !step.allowed,
  });

  const copyButton = h('button.btn.btn--ghost.btn--small', {
    type: 'button',
    text: 'Copy',
    onClick: async () => {
      const ok = await copyText(step.display);
      toast({ kind: ok ? 'ok' : 'error', title: ok ? 'Command copied' : 'Copy failed', timeout: 2000 });
    },
  });

  appendAll(
    node,
    h('div.step__top', {}, [
      h('span.step__index', { text: String(index + 1) }),
      h('span.step__risk', {}, [riskBadge(step.risk)]),
    ]),
    h('div.step__cmd', { text: step.display }),
    step.why ? h('div.step__why', { text: step.why }) : null,
    step.allowed
      ? null
      : h('div.step__reason', { text: step.reasons?.join(' ') || 'Refused by the safety policy.' }),
    h('div.step__foot', {}, [runButton, copyButton]),
  );

  if (step.allowed) {
    runButton.addEventListener('click', async () => {
      const approved = await approve({
        title: 'Run this command?',
        sub: step.risk === 'destructive'
          ? 'This command discards work. Read it carefully before approving.'
          : 'The command runs exactly as shown.',
        steps: [step],
        confirmLabel: 'Run',
        danger: step.risk === 'destructive',
      });
      if (!approved) return;

      runButton.disabled = true;
      runButton.textContent = 'Running…';
      node.classList.add('is-running');

      try {
        const response = await api.runStep(state.repoPath, step, {
          confirmed: true,
          allowDestructive: step.risk === 'destructive',
        });
        const succeeded = response.status === 'ran';
        applyOutcome(node, response, succeeded ? 'done' : 'failed');
        runButton.textContent = succeeded ? 'Done' : 'Failed';
        if (succeeded) {
          toast({ kind: 'ok', title: 'Command finished', body: step.display, timeout: 3000 });
        }
        context.onExecuted?.();
      } catch (error) {
        node.classList.remove('is-running');
        node.classList.add('is-failed');
        appendOutput(node, error.message, true);
        runButton.textContent = 'Failed';
        runButton.disabled = false;
      }
    });
  }

  return node;
}

function applyOutcome(node, result, kind) {
  node.classList.remove('is-running');
  node.classList.add(kind === 'done' ? 'is-done' : 'is-failed');

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (output) appendOutput(node, output, kind !== 'done', result.durationMs);
  else if (kind !== 'done') appendOutput(node, result.reason || 'The command did not complete.', true);
}

function appendOutput(node, text, isError, durationMs = 0) {
  node.querySelector('.step__output')?.remove();

  const block = h('div.step__output', {
    text: durationMs ? `${text}\n\n(${formatDuration(durationMs)})` : text,
  });
  if (isError) block.style.color = 'var(--del-text)';

  const foot = node.querySelector('.step__foot');
  if (foot) foot.after(block);
  else node.append(block);
}

/** Approval sheet listing every command and its risk. Resolves true if approved. */
function approve({ title, sub, steps, confirmLabel = 'Run', danger = false }) {
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });

  for (const step of steps) {
    appendAll(body, h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } }, [
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
        riskBadge(step.risk),
        step.why ? h('span.muted', { text: step.why, style: { fontSize: '12px' } }) : null,
      ]),
      h('div.cmd', { text: step.display.replace(/^git\s+/, '') }),
      step.reasons?.length && step.risk !== 'safe'
        ? h('div.step__reason', { text: step.reasons.join(' ') })
        : null,
    ]));
  }

  if (danger) {
    body.append(h('div.msg__note.msg__note--error', { text: 'This action cannot be undone from GitSynapse.' }));
  }

  return confirmDialog({ title, sub, body, confirmLabel, tone: danger ? 'danger' : 'primary' });
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

function persistSession() {
  if (transcript.length === 0) return;
  if (!sessionId) sessionId = crypto.randomUUID();

  const firstUser = transcript.find((entry) => entry.role === 'user');
  api.saveSession({
    id: sessionId,
    title: firstUser ? firstUser.content.slice(0, 80) : 'Conversation',
    updatedAt: new Date().toISOString(),
    repo: state.repoPath,
    turns: transcript.slice(-40),
  }).catch(() => {
    // History is a convenience; failing to save it must never surface as an error.
  });
}

export function resetConversation() {
  transcript.length = 0;
  sessionId = null;
  activeController?.abort();
  streaming = false;
  renderEmpty();
  updateSendState();
}

export function focusComposer() {
  elements.input?.focus();
}

/** Called when the repository changes so the greeting reflects reality. */
export function refreshGreeting() {
  if (transcript.length === 0) renderEmpty();
}
