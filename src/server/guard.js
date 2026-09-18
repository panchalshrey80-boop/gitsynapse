import { allowedHosts } from './env.js';
/**
 * Request guards.
 *
 * The HTTP server is bound to 127.0.0.1, but a loopback bind alone is not
 * sufficient: any page open in the user's browser can reach 127.0.0.1, and a
 * DNS-rebinding attack can make a remote hostname resolve there. Both classes
 * of attack are blocked by validating Host and Origin on every request, which
 * is the same defence used by well-behaved local dev servers.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameOf(value) {
  if (!value) return null;
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when the Host header targets this machine's loopback interface, or a
 * preview host explicitly allowed via GITSYNAPSE_ALLOWED_HOSTS (comma separated).
 */
export function isAllowedHost(hostHeader) {
  const hostname = hostnameOf(hostHeader);
  if (!hostname) return false;
  if (LOOPBACK_HOSTS.has(hostname)) return true;

  const extra = allowedHosts()
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  return extra.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

/**
 * Cross-origin requests are rejected. A missing Origin is fine: that means a
 * non-browser client (curl, the smoke test, Electron in its own right).
 */
export function isAllowedOrigin(originHeader, hostHeader) {
  if (!originHeader || originHeader === 'null') return true;
  const originHost = hostnameOf(originHeader);
  if (!originHost) return false;
  if (LOOPBACK_HOSTS.has(originHost)) return true;
  return originHost === hostnameOf(hostHeader);
}

/**
 * Express middleware implementing both checks plus a hard block on
 * cross-site requests.
 */
export function localOnlyGuard(req, res, next) {
  if (!isAllowedHost(req.headers.host)) {
    res.status(403).json({
      error: 'blocked_host',
      message: 'This server only accepts connections addressed to localhost.',
    });
    return;
  }

  if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
    res.status(403).json({
      error: 'blocked_origin',
      message: 'Cross-origin requests are not accepted.',
    });
    return;
  }

  // Text/plain POSTs from a plain HTML form cannot carry JSON; requiring a JSON
  // content type removes that CSRF vector without needing a token.
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      res.status(415).json({
        error: 'unsupported_media_type',
        message: 'Requests that change state must be sent as application/json.',
      });
      return;
    }
  }

  next();
}

/**
 * Minimal fixed-window rate limiter. Not a security boundary on its own — the
 * loopback bind is — but it stops a runaway UI loop from burning API credit.
 */
export function rateLimit({ windowMs = 60_000, max = 120 } = {}) {
  const hits = new Map();

  return (req, res, next) => {
    const key = req.ip || 'local';
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      next();
      return;
    }

    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.start + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'rate_limited',
        message: `Too many requests. Try again in ${retryAfter}s.`,
      });
      return;
    }

    next();
  };
}
