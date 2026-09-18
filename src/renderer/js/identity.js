/**
 * The name and email git stamps on every commit.
 *
 * A freshly installed git has neither, and it will not guess: the commit simply
 * fails. That single missing setting is the most common reason a first commit
 * does not happen, so the app asks for it in two places — the settings dialog,
 * and in a dialog offered directly when a commit fails for this reason — and
 * writes it to the user's global git configuration, because a per-repository
 * answer would make them repeat this for every project.
 */

import { api } from './api.js';
import { h, openModal, toast } from './ui.js';

/**
 * Builds the two inputs. Exported so the settings dialog can embed the same
 * fields inside its own save flow rather than having two implementations.
 *
 * @param {{name?:string, email?:string}} values
 */
export function identityFields(values = {}) {
  const nameInput = h('input.input', {
    type: 'text',
    value: values.name || '',
    placeholder: 'Ada Lovelace',
    autocomplete: 'name',
  });
  const emailInput = h('input.input.input--mono', {
    type: 'text',
    value: values.email || '',
    placeholder: 'ada@example.com',
    autocomplete: 'email',
  });

  const field = h('div.field', {}, [
    h('label.field__label', { text: 'Your name and email' }),
    nameInput,
    h('div.field__hint', { text: 'Recorded in every commit you make, and stored in your global git configuration so it works in every project. Nothing is sent anywhere.' }),
  ]);
  const emailField = h('div.field', {}, [
    h('label.field__label', { text: 'Email' }),
    emailInput,
  ]);

  return {
    nameInput,
    emailInput,
    field,
    emailField,
    values: () => ({ name: nameInput.value.trim(), email: emailInput.value.trim() }),
  };
}

/**
 * Asks for the identity and saves it. Returns the saved identity, or null if
 * the user dismissed the dialog.
 *
 * @param {{reason?: string, headline?: string}} [options]
 */
export async function askForIdentity({ reason = '', headline = 'Git needs to know who you are' } = {}) {
  const current = await api.gitIdentity().catch(() => ({ name: '', email: '' }));
  const fields = identityFields(current);
  fields.nameInput.setAttribute('data-autofocus', 'true');

  const handle = openModal({
    title: headline,
    sub: reason || 'Git records a name and email in every commit, and refuses to commit without them.',
    body: h('div', {}, [
      fields.field,
      fields.emailField,
      h('div.field', {}, [
        h('label.field__label', { text: 'Written to' }),
        h('div.cmd', { text: 'git config --global user.name "…" && git config --global user.email "…"' }),
      ]),
    ]),
    actions: [
      { label: 'Not now', value: null },
      { label: 'Save and try again', value: 'save', tone: 'primary' },
    ],
  });

  if ((await handle.promise) !== 'save') return null;

  try {
    const result = await api.action('setIdentity', fields.values());
    const identity = result.identity || fields.values();
    toast({
      kind: 'ok',
      title: 'Saved',
      body: `Commits will be recorded as ${identity.name} <${identity.email}>.`,
      timeout: 3600,
    });
    return identity;
  } catch (error) {
    toast({ kind: 'error', title: 'Could not save that', body: error.message, timeout: 8000 });
    return null;
  }
}

/** True when a failed action means "git has no identity configured". */
export function isIdentityFailure(error) {
  return Boolean(error?.payload?.needsIdentity) || error?.code === 'identity_missing';
}
