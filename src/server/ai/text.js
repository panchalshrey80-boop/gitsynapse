/**
 * Text hygiene for anything sent to the model.
 *
 * Two failure modes are being prevented here, and neither is theoretical:
 *
 *  1. **Lone surrogates.** Command output, diffs and file paths are truncated
 *     with `String.prototype.slice`, which counts UTF-16 code units. Cutting a
 *     string in the middle of an emoji or any non-BMP character leaves half a
 *     surrogate pair behind. `JSON.stringify` happily emits `"\ud83d"`, and the
 *     receiving API rejects the whole request as invalid Unicode — HTTP 400,
 *     with an error message that says nothing about truncation. Repeating the
 *     same request therefore fails the same way, which is exactly how a
 *     conversation gets stuck.
 *
 *  2. **Control characters.** A NUL byte or an escape sequence from a binary
 *     file's diff can end up inside a prompt. Most gateways tolerate \n and \t
 *     and reject the rest.
 */

/** Matches a high surrogate not followed by a low one, or a low with no high. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g;

/** Control characters that are never meaningful in a prompt. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Makes a string safe to send over the wire.
 *
 * @param {unknown} value
 * @param {object} [options]
 * @param {number} [options.maxChars] Truncate to this many characters.
 * @returns {string}
 */
export function sanitizeText(value, { maxChars = 0 } = {}) {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);

  if (maxChars > 0 && text.length > maxChars) {
    text = text.slice(0, maxChars);
    // Cutting can itself create the problem, so the order matters: truncate,
    // then repair. A trailing high surrogate would otherwise survive.
    text = stripTrailingHighSurrogate(text);
  }

  return text
    .replace(LONE_SURROGATE, (match) => (match.length > 1 ? match[0] + '\uFFFD' : '\uFFFD'))
    .replace(CONTROL_CHARS, '');
}

/**
 * Removes a high surrogate left dangling at the end of a string.
 * @param {string} text
 */
function stripTrailingHighSurrogate(text) {
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return `${text.slice(0, -1)}\uFFFD`;
  return text;
}

/**
 * Sanitises a conversation before dispatch.
 *
 * Roles are re-asserted from a fixed set and content is coerced to a string, so
 * a malformed history entry (a null, a nested object, an injected `system` role
 * from stored session data) cannot reshape the request the way a caller
 * intended it to.
 *
 * @param {Array<{role?:string, content?:unknown}>} turns
 * @param {{maxChars?:number, limit?:number}} [options]
 * @returns {Array<{role:'user'|'assistant', content:string}>}
 */
export function sanitizeTurns(turns, { maxChars = 6_000, limit = 10 } = {}) {
  if (!Array.isArray(turns)) return [];

  return turns
    .filter((turn) => turn && ['user', 'assistant'].includes(turn.role))
    .slice(-limit)
    .map((turn) => ({
      role: turn.role,
      content: sanitizeText(turn.content, { maxChars }),
    }))
    .filter((turn) => turn.content.trim().length > 0);
}
