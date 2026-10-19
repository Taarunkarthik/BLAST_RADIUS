/**
 * Same-origin JSON client for the local harness.
 *
 * Every request carries the per-session token from the document meta tag. The
 * token is read lazily so this module can be imported by tooling without a DOM.
 * The server enforces loopback + origin + token checks; this helper only adds
 * the header and turns error payloads into readable Error objects.
 */

export class ApiError extends Error {
  constructor(message, status = 0, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

let cachedToken = null;

export function sessionToken() {
  if (cachedToken !== null) return cachedToken;
  const meta = typeof document === 'undefined' ? null : document.querySelector('meta[name="blastradius-token"]');
  cachedToken = meta?.content ?? '';
  return cachedToken;
}

export async function api(path, body) {
  const headers = { 'X-BlastRadius-Token': sessionToken() };
  const init = { method: body === undefined ? 'GET' : 'POST', headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new ApiError(`The local harness could not be reached: ${error.message}`, 0);
  }

  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const detail = typeof data?.detail === 'string' ? data.detail : 'Please check the request fields and try again.';
    throw new ApiError(detail, response.status, data);
  }
  return data;
}
