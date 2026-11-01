'use strict';

// The Controller and optional probe use only this small JSON request subset.
// Never follow redirects: the ZeroTier token must stay on the configured host.
class HTTPError extends Error {
  constructor(statusCode) {
    super(`Controller HTTP request failed (${statusCode})`);
    this.name = 'HTTPError';
    this.code = 'ERR_HTTP_RESPONSE';
    this.statusCode = statusCode;
  }
}

async function controllerHttp(address, options = {}) {
  let url;
  try {
    url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch (_) {
    throw Object.assign(new TypeError('Controller URL must be an HTTP(S) URL without credentials'), {code: 'ERR_INVALID_URL'});
  }

  const timeout = options.timeout;
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 0)) {
    throw new TypeError('Controller request timeout must be a non-negative integer');
  }
  const signal = timeout ? AbortSignal.timeout(timeout) : undefined;
  const headers = new Headers(options.headers);
  if (options.json && !headers.has('Accept')) headers.set('Accept', 'application/json');
  let body = options.body;
  if (body !== undefined && options.json) {
    body = JSON.stringify(body);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  }

  try {
    const response = await fetch(url, {
      method: options.method || (body === undefined ? 'GET' : 'POST'),
      headers, body, signal, redirect: 'manual'
    });
    if (!response.ok) {
      if (response.body) await response.body.cancel();
      throw new HTTPError(response.status);
    }
    const text = await response.text();
    let result = text;
    if (options.json && text) {
      try {
        result = JSON.parse(text);
      } catch (_) {
        throw Object.assign(new Error('Controller returned invalid JSON'), {
          name: 'ParseError', code: 'ERR_INVALID_JSON', statusCode: response.status
        });
      }
    }
    return {body: result, statusCode: response.status, headers: Object.fromEntries(response.headers)};
  } catch (error) {
    if (signal && signal.aborted) {
      throw Object.assign(new Error('Controller request timed out'), {code: 'ETIMEDOUT'});
    }
    if (error instanceof HTTPError || error.code === 'ERR_INVALID_JSON') throw error;
    // Fetch wraps connection errors. Surface their code without request headers,
    // response contents or URL credentials in logs and diagnostic responses.
    throw Object.assign(new Error('Controller request failed'), {code: error.cause && error.cause.code || 'ERR_HTTP_REQUEST'});
  }
}

controllerHttp.HTTPError = HTTPError;
module.exports = controllerHttp;
