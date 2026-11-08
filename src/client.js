'use strict';

const DEFAULT_BASE_URL = 'http://127.0.0.1:18880';

function normalizeBaseUrl(value = DEFAULT_BASE_URL) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error('The local account router client only accepts a loopback HTTP URL.');
  }
  return url.toString().replace(/\/$/, '');
}

class AccountRouterClient {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetch = options.fetch || globalThis.fetch;
    if (typeof this.fetch !== 'function') throw new TypeError('A fetch implementation is required.');
  }

  async _request(path, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: { Accept: 'application/json', ...(options.headers || {}) }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body?.error?.message || body?.error || `Account Router returned HTTP ${response.status}.`);
      error.status = response.status;
      error.code = body?.error?.code || 'router_error';
      throw error;
    }
    return body;
  }

  getChain() {
    return this._request('/api/v1/account-chain', { cache: 'no-store' });
  }

  reorder(accountIds, expectedRevision) {
    return this._request('/api/v1/account-chain/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountIds, expectedRevision })
    });
  }

  chatCompletion(payload, options = {}) {
    return this.fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: JSON.stringify(payload),
      signal: options.signal
    });
  }
}

function createRouterClient(options) { return new AccountRouterClient(options); }

module.exports = { AccountRouterClient, createRouterClient, DEFAULT_BASE_URL };
