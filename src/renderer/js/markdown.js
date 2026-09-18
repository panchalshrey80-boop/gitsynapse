/**
 * Minimal Markdown renderer for copilot replies.
 *
 * Scope is deliberately narrow: paragraphs, bullet and numbered lists, fenced
 * code, inline code, bold and italic. Everything is constructed as DOM nodes,
 * so model output is never interpreted as HTML. No links are rendered — a
 * clickable URL that a model produced is a phishing primitive we do not need.
 */

import { h } from './ui.js';

const INLINE_PATTERN = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_)/g;

/**
 * @param {string} text
 * @param {HTMLElement} target
 */
function inline(text, target) {
  let index = 0;
  INLINE_PATTERN.lastIndex = 0;

  let match;
  while ((match = INLINE_PATTERN.exec(text)) !== null) {
    if (match.index > index) target.append(text.slice(index, match.index));
    const token = match[0];

    if (token.startsWith('`')) {
      target.append(h('code', { text: token.slice(1, -1) }));
    } else if (token.startsWith('**') || token.startsWith('__')) {
      target.append(h('strong', {}, [token.slice(2, -2)]));
    } else {
      target.append(h('em', {}, [token.slice(1, -1)]));
    }

    index = match.index + token.length;
  }

  if (index < text.length) target.append(text.slice(index));
}

/**
 * @param {string} source
 * @returns {DocumentFragment}
 */
export function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n');

  let paragraph = [];
  let list = null; // { node: HTMLOListElement|HTMLUListElement, ordered: boolean }
  let fence = null; // { language: string, lines: string[] }

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const node = h('p');
    inline(paragraph.join(' '), node);
    fragment.append(node);
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    fragment.append(list.node);
    list = null;
  };

  for (const line of lines) {
    if (fence) {
      if (line.trim().startsWith('```')) {
        fragment.append(h('pre', {}, [h('code', { text: fence.lines.join('\n') })]));
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }

    if (line.trim().startsWith('```')) {
      flushParagraph();
      flushList();
      fence = { language: line.trim().slice(3).trim(), lines: [] };
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^\s*#{1,4}\s+(.*)$/.exec(line);

    if (heading) {
      flushParagraph();
      flushList();
      const node = h('h3');
      inline(heading[1], node);
      fragment.append(node);
      continue;
    }

    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { node: h(ordered ? 'ol' : 'ul'), ordered };
      }
      const item = h('li');
      inline((bullet || numbered)[1], item);
      list.node.append(item);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  if (fence) fragment.append(h('pre', {}, [h('code', { text: fence.lines.join('\n') })]));
  flushParagraph();
  flushList();

  return fragment;
}
