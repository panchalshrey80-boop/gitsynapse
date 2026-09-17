/**
 * Settings dialog: AI provider, API key, model, and execution policy.
 *
 * The API key is written to the server and never read back into the page — the
 * field only ever shows a mask. That is a deliberate constraint: if the key is
 * never in the DOM, it cannot leak through a screenshot, a devtools session or
 * a renderer bug.
 */

import { api } from './api.js';
import { state, setState } from './state.js';
import { h, mount, openModal, toast } from './ui.js';
import { updateModelPill, refreshGreeting } from './chat.js';

export function initSettings() {
  document.getElementById('btn-settings')?.addEventListener('click', () => openSettings());
}

export async function openSettings(section = 'ai') {
  const settings = await api.aiSettings().catch(() => null);
  if (!settings) {
    toast({ kind: 'error', title: 'Cannot reach the server', body: 'Settings are stored by the local server.' });
    return;
  }

  const body = h('div');
  const status = h('div.field__hint');

  /* --- Provider --- */
  // The list comes from the server's registry, so this dialog never has to be
  // edited when a provider is added or its default model changes.
  const providers = Array.isArray(settings.providers) ? settings.providers : [];
  let provider = providers.find((entry) => entry.id === settings.provider) || providers[0] || {
    id: 'mesh', label: 'Mesh', keyPlaceholder: 'rsk_…', defaultModel: '', modelExamples: [],
  };
  const keysSaved = settings.keysSaved || {};

  const providerSelect = h('select.select', {}, providers.map((entry) => h('option', {
    value: entry.id,
    text: entry.label + (keysSaved[entry.id] ? ' — key saved' : ''),
  })));
  providerSelect.value = provider.id;

  const providerBlurb = h('div.field__hint');

  /* --- API key --- */
  const keyInput = h('input.input.input--mono', {
    type: 'password',
    placeholder: provider.keyPlaceholder,
    autocomplete: 'off',
    spellcheck: 'false',
  });

  const keyHint = h('div.field__hint');

  const verifyButton = h('button.btn.btn--small', { type: 'button', text: 'Test connection' });

  /* --- Model --- */
  const modelSelect = h('select.select');
  const modelInput = h('input.input.input--mono', { type: 'text', value: settings.model });
  const refreshModels = h('button.btn.btn--small', { type: 'button', text: 'Load models' });

  const modelRow = h('div', { style: { display: 'flex', gap: '8px' } }, [modelSelect, refreshModels]);
  modelRow.style.display = 'none';

  /* --- Policy --- */
  const policySelect = h('select.select', {}, [
    h('option', { value: 'all', text: 'Always confirm (recommended)' }),
    h('option', { value: 'destructive', text: 'Confirm destructive commands only' }),
    h('option', { value: 'never', text: 'Never confirm (unsafe)' }),
  ]);
  policySelect.value = settings.confirmPolicy;

  const autoRunReadOnly = h('input', { type: 'checkbox', checked: settings.autoRunReadOnly });
  const aiEnabled = h('input', { type: 'checkbox', checked: settings.aiEnabled });

  const modelHint = h('div.field__hint');

  /**
   * Repaints every part of the form that depends on the chosen provider.
   * Called once on open and again on every change, so the dialog can never show
   * one provider's placeholder next to another provider's saved-key state.
   */
  function applyProvider(id, { keepModel = false } = {}) {
    const previous = provider;
    const next = providers.find((entry) => entry.id === id) || provider;
    const changed = next.id !== previous.id;
    provider = next;

    providerBlurb.textContent = provider.blurb || '';
    keyInput.placeholder = provider.keyPlaceholder || 'API key';
    keyInput.value = '';
    verifyButton.disabled = false;
    verifyButton.textContent = 'Test connection';
    status.textContent = '';

    const saved = Boolean(keysSaved[provider.id]);
    keyHint.textContent = saved
      ? `A ${provider.label} key is saved and encrypted on disk. Leave this blank to keep it, or type a new one to replace it. Existing keys for other providers are untouched.`
      : `Get a key from ${provider.keyUrl || provider.label}. It is stored encrypted in your user folder and sent only to ${provider.label}.`;

    const examples = provider.modelExamples?.length
      ? ` For example ${provider.modelExamples.slice(0, 2).join(' or ')}.`
      : '';
    modelHint.textContent = `Any model id your ${provider.label} key can use.${examples} Use "Load models" to list them.`;

    // A model id means nothing to another vendor, and keeping the old one would
    // 404 on the first message. So the default follows the provider — unless the
    // user typed an id of their own, which is left alone for gateways that serve
    // custom names. "Untouched" means empty or still the previous default.
    if (!keepModel && changed) {
      const untouched = !modelInput.value.trim() || modelInput.value.trim() === previous.defaultModel;
      if (untouched) modelInput.value = provider.defaultModel || '';
    }
  }

  providerSelect.addEventListener('change', () => applyProvider(providerSelect.value));

  // Typing a model id counts as taking ownership of it: after this the switch
  // above stops replacing it.
  modelInput.addEventListener('input', () => { modelInput.dataset.touched = 'true'; });

  body.append(
    h('div.field', {}, [
      h('label.field__label', { text: 'AI provider' }),
      providerSelect,
      providerBlurb,
    ]),
    h('div.field', {}, [
      h('label.field__label', { text: 'API key' }),
      h('div', { style: { display: 'flex', gap: '8px' } }, [keyInput, verifyButton]),
      keyHint,
    ]),
    h('div.field', {}, [
      h('label.field__label', { text: 'Model' }),
      modelInput,
      modelRow,
      modelHint,
    ]),
    h('div.field', {}, [
      h('label.field__label', { text: 'Command confirmation' }),
      policySelect,
      h('div.field__hint', {
        text: 'GitSynapse classifies every command itself — the model\'s own risk label is ignored. Destructive commands always ask.',
      }),
    ]),
    h('label.check', { style: { marginBottom: '12px' } }, [
      autoRunReadOnly,
      h('span', { text: 'Run read-only commands (status, log, diff) without asking' }),
    ]),
    h('label.check', { style: { marginBottom: '12px' } }, [
      aiEnabled,
      h('span', { text: 'Enable the AI copilot' }),
    ]),
    h('div.card', {}, [
      h('div.card__head', {}, [h('div.card__title', { text: 'Environment' })]),
      h('div.card__body', {}, [
        h('div.row', {}, [
          h('div.row__main', {}, [
            h('div.row__name', { text: 'Settings file' }),
            h('div.row__meta', { text: settings.configDir }),
          ]),
        ]),
        h('div.row', {}, [
          h('div.row__main', {}, [
            h('div.row__name', { text: 'Git version' }),
            h('div.row__meta', {
              text: state.gitInfo ? `${state.gitInfo.git.version || 'not found'}` : 'checking…',
              title: state.gitInfo?.git?.binary || '',
            }),
          ]),
          h('button.btn.btn--small', {
            type: 'button',
            text: 'Open config folder',
            onClick: () => {
              toast({ kind: 'info', title: 'Config folder', body: settings.configDir, timeout: 9000 });
            },
          }),
        ]),
      ]),
    ]),
    status,
  );

  /* --- Behaviour --- */

  applyProvider(provider.id);

  verifyButton.addEventListener('click', async () => {
    const candidate = keyInput.value.trim();
    // Whether a key exists is per provider: a saved Mesh key says nothing about
    // whether an Anthropic key is present.
    if (!candidate && !keysSaved[provider.id]) {
      status.textContent = `Enter a ${provider.label} key first.`;
      status.style.color = 'var(--del-text)';
      return;
    }

    verifyButton.disabled = true;
    verifyButton.textContent = 'Testing…';
    status.textContent = '';

    try {
      const result = await api.verifyKey(candidate || undefined, provider.id);
      status.textContent = `Connection works. ${result.modelCount} models available on this ${provider.label} key.`;
      status.style.color = 'var(--ok)';
      if (result.modelCount === 0) {
        status.textContent = `The key works but no models are enabled on it. Check your ${provider.label} dashboard.`;
        status.style.color = 'var(--warn)';
      }
    } catch (error) {
      status.textContent = error.message;
      status.style.color = 'var(--del-text)';
    } finally {
      verifyButton.disabled = false;
      verifyButton.textContent = 'Test connection';
    }
  });

  refreshModels.addEventListener('click', async () => {
    refreshModels.disabled = true;
    refreshModels.textContent = 'Loading…';

    try {
      const { models } = await api.models(true, provider.id);
      modelSelect.replaceChildren();
      for (const model of models) {
        modelSelect.append(h('option', { value: model.id, text: model.id }));
      }
      modelSelect.value = settings.model;
      modelRow.style.display = 'flex';
      modelSelect.style.flex = '1';
      toast({ kind: 'ok', title: `${models.length} models loaded`, body: 'Pick one, then Save.', timeout: 3200 });
    } catch (error) {
      toast({ kind: 'error', title: 'Could not load models', body: error.message });
    } finally {
      refreshModels.disabled = false;
      refreshModels.textContent = 'Load models';
    }
  });

  modelSelect.addEventListener('change', () => { modelInput.value = modelSelect.value; });

  const handle = openModal({
    title: 'Settings',
    sub: section === 'ai'
      ? 'The copilot talks to your chosen provider; everything else runs locally.'
      : '',
    body,
    wide: true,
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Save',
        value: 'save',
        tone: 'primary',
      },
    ],
  });

  if ((await handle.promise) !== 'save') return;

  try {
    const patch = {
      provider: provider.id,
      model: modelInput.value.trim() || provider.defaultModel,
      confirmPolicy: policySelect.value,
      autoRunReadOnly: autoRunReadOnly.checked,
      aiEnabled: aiEnabled.checked,
    };
    if (keyInput.value.trim()) patch.apiKey = keyInput.value.trim();

    const { settings: updated } = await api.saveAiSettings(patch);
    setState({ settings: updated });
    updateModelPill();
    refreshGreeting();
    const savedLabel = (updated.providers || []).find((entry) => entry.id === updated.provider)?.label
      || updated.provider;
    toast({
      kind: 'ok',
      title: 'Settings saved',
      body: updated.hasApiKey
        ? `${savedLabel} · ${updated.model}`
        : `No ${savedLabel} API key saved yet.`,
    });
  } catch (error) {
    toast({ kind: 'error', title: 'Could not save settings', body: error.message });
  }
}
