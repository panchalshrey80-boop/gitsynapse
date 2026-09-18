/**
 * DOM helpers.
 *
 * Everything builds real element nodes rather than HTML strings. That is not
 * ceremony: commit subjects, file names and AI output all end up on screen, and
 * text that arrives through innerHTML is an injection risk the moment any of it
 * originates outside the app. `text()` is the only path for untrusted strings.
 */

/**
 * Element factory.
 * @param {string} tag  Tag name, optionally with ".class" and "#id" suffixes.
 * @param {object} [props]
 * @param {Array<Node|string>|string} [children]
 */
export function h(tag, props = {}, children = []) {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const element = document.createElement(name || 'div');

  for (const token of rest) {
    if (token.startsWith('.')) element.classList.add(token.slice(1));
    else if (token.startsWith('#')) element.id = token.slice(1);
  }

  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') element.className = `${element.className} ${value}`.trim();
    else if (key === 'text') element.textContent = String(value);
    else if (key === 'html') element.innerHTML = value; // Only for trusted, app-authored markup.
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(element.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in element && key !== 'list' && typeof value !== 'object') {
      element[key] = value;
    } else {
      element.setAttribute(key, String(value));
    }
  }

  const list = Array.isArray(children) ? children : [children];
  for (const child of list.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return element;
}

/** Removes every child of a node. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * Appends children, skipping null/undefined/false.
 *
 * `Element.append(null)` inserts the literal text "null", which is how a
 * conditional child ends up rendered on screen. Use this instead of `.append`
 * whenever any argument is conditional.
 *
 * @param {Node} node
 * @param {...(Node|string|null|undefined|false)} children
 */
export function appendAll(node, ...children) {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Replaces a node's children in one pass. */
export function mount(node, ...children) {
  clear(node);
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

/** Splits a path into a dimmed directory part and a bright file name. */
export function pathParts(filePath) {
  const normalised = String(filePath).replace(/\\/g, '/');
  const index = normalised.lastIndexOf('/');
  if (index === -1) return { dir: '', name: normalised };
  return { dir: `${normalised.slice(0, index + 1)}`, name: normalised.slice(index + 1) };
}

export function shortPath(filePath, maxLength = 52) {
  const value = String(filePath);
  if (value.length <= maxLength) return value;
  const tail = value.slice(-(maxLength - 1));
  return `…${tail}`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));

  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 604_800) return `${Math.round(seconds / 86_400)}d ago`;
  if (seconds < 2_592_000) return `${Math.round(seconds / 604_800)}w ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/* ------------------------------------------------------------------ *
 * Status indicators
 * ------------------------------------------------------------------ */

const RISK_LABELS = {
  safe: 'read only',
  network: 'network',
  writes: 'writes',
  destructive: 'destructive',
  blocked: 'blocked',
};

export function riskBadge(level) {
  const normalised = RISK_LABELS[level] ? level : 'writes';
  return h(`span.badge.badge--${normalised}`, { text: RISK_LABELS[normalised] });
}

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

const TOAST_ROOT = () => document.getElementById('toast-root');

/**
 * @param {{kind?:'ok'|'error'|'warn'|'info', title:string, body?:string, timeout?:number}} options
 */
export function toast({ kind = 'info', title, body = '', timeout = 5200 }) {
  const root = TOAST_ROOT();
  if (!root) return () => {};

  const node = h(`div.toast.toast--${kind}`, { role: 'status' }, [
    h('div.grow', {}, [
      h('div.toast__title', { text: title }),
      body ? h('div.toast__body', { text: body }) : null,
    ]),
    h('button.toast__close', {
      type: 'button',
      text: '✕',
      'aria-label': 'Dismiss',
      onClick: () => remove(),
    }),
  ]);

  let timer = null;
  const remove = () => {
    if (timer) clearTimeout(timer);
    node.remove();
  };

  root.append(node);
  if (timeout > 0) timer = setTimeout(remove, timeout);
  return remove;
}

/* ------------------------------------------------------------------ *
 * Modal
 * ------------------------------------------------------------------ */

/**
 * Opens a modal and resolves with the value passed to `close`.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {Node|string} [options.body]
 * @param {Array<{label:string, value:any, tone?:string, primary?:boolean}>} [options.actions]
 * @param {boolean} [options.wide]
 * @param {()=>void} [options.onMount]
 * @returns {{close:(value?:any)=>void, root:HTMLElement}}
 */
export function openModal({ title, sub = '', body, actions = [], wide = false, onMount }) {
  const root = document.getElementById('modal-root');
  if (!root) return { close: () => {}, root: document.body };

  root.hidden = false;
  clear(root);

  let settled = false;
  const previouslyFocused = document.activeElement;

  const close = (value) => {
    if (settled) return;
    settled = true;
    document.removeEventListener('keydown', onKeydown, true);
    clear(root);
    root.hidden = true;
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    if (typeof resolveWith === 'function') resolveWith(value);
  };

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(undefined);
      return;
    }
    if (event.key !== 'Tab') return;

    // Keep focus inside the dialog while it is open.
    const focusable = modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const modal = h(`div.modal${wide ? '.modal--wide' : ''}`, { role: 'dialog', 'aria-modal': 'true' }, [
    h('div.modal__head', {}, [
      h('div', {}, [
        h('div.modal__title', { text: title }),
        sub ? h('div.modal__sub', { text: sub }) : null,
      ]),
      h('button.btn.btn--ghost.btn--icon', {
        type: 'button',
        'aria-label': 'Close',
        onClick: () => close(undefined),
        html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
      }),
    ]),
    h('div.modal__body', {}, body ? [typeof body === 'string' ? h('p', { text: body }) : body] : []),
    actions.length > 0
      ? h('div.modal__foot', {}, actions.map((action) => h(
          `button.btn${action.tone === 'primary' ? '.btn--primary' : action.tone === 'danger' ? '.btn--danger' : ''}${action.left ? '.left' : ''}`,
          { type: 'button', text: action.label, onClick: () => close(action.value) },
        )))
      : null,
  ]);

  root.append(h('div', {
    class: 'modal-scrim',
    onClick: (event) => {
      if (event.target === event.currentTarget) close(undefined);
    },
  }, [modal]));

  document.addEventListener('keydown', onKeydown, true);

  let resolveWith;
  const promise = new Promise((resolve) => { resolveWith = resolve; });
  onMount?.(modal, close);

  const focusTarget =
    modal.querySelector('[data-autofocus]') ||
    modal.querySelector('input, textarea, button.btn--primary') ||
    modal;
  focusTarget.focus?.();

  return { close, root, promise, element: modal };
}

/** Convenience confirmation dialog. Resolves true when confirmed. */
export function confirmDialog({ title, sub, body, confirmLabel = 'Confirm', tone = 'primary' }) {
  const { promise } = openModal({
    title,
    sub,
    body,
    actions: [
      { label: 'Cancel', value: false },
      { label: confirmLabel, value: true, tone },
    ],
  });
  return promise.then((value) => value === true);
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

/** Copies text, falling back to a hidden textarea when the clipboard API is blocked. */
export async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const area = h('textarea', { value, style: { position: 'fixed', opacity: '0' } });
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

export const ICONS = {
  folder: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h8A1.5 1.5 0 0 1 20 10v7.5A1.5 1.5 0 0 1 18.5 19h-14A1.5 1.5 0 0 1 3 17.5Z"/></svg>',
  repo: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h9a3 3 0 0 1 3 3v13H7.5A2.5 2.5 0 0 1 5 17.5V6a2 2 0 0 1 2-2Z"/><path d="M5 17.5A2.5 2.5 0 0 1 7.5 15H18"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></svg>',
  minus: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  undo: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h9a6 6 0 0 1 0 12h-4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 12h10l1-12"/></svg>',
  external: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>',
  spark: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M4.2 7.5l2.6 1.5M17.2 15l2.6 1.5M4.2 16.5l2.6-1.5M17.2 9l2.6-1.5"/><circle cx="12" cy="12" r="3.2"/></svg>',
};

export function icon(name) {
  const span = h('span', { html: ICONS[name] || '', 'aria-hidden': 'true' });
  return span.firstChild || span;
}
