'use strict';

const API_VERSION = 1;
const MODULE_VERSION = '1.0.0';
const { isLocalProviderAccount, summarizeLocalPerformance } = require('./AdaptiveLocalRouting.js');

function accountChainSnapshot(engine) {
  const active = engine.resolveActiveAccount();
  return {
    apiVersion: API_VERSION,
    moduleVersion: MODULE_VERSION,
    revision: engine.chain.revision ?? 0,
    updatedAt: engine.chain.updatedAt,
    enabled: engine.chain.enabled !== false,
    thresholdPercent: engine.chain.thresholdPercent ?? engine.thresholdPercent,
    quotaResetHours: engine.chain.quotaResetHours ?? engine.quotaResetHours ?? 5,
    engineMode: 'provider-adapter',
    providerState: active && engine.tierHealth.get(active.id)?.requestState === 'available' ? 'verified' : 'unverified',
    activeAccountId: active?.id ?? null,
    accounts: engine.chain.accounts.map((account, index) => ({
      id: account.id,
      name: typeof account.name === 'string' && !account.name.includes('@') ? account.name : `Account ${index + 1}`,
      rank: index + 1,
      enabled: account.enabled !== false,
      provider: account.provider || 'unconfigured',
      model: account.model || 'unconfigured',
      remainingPercent: engine.tierHealth.get(account.id)?.totalRemainingPercent ?? null,
      availability: engine.tierHealth.get(account.id)?.requestState || 'unverified',
      ...(isLocalProviderAccount(account)
        ? { localAi: summarizeLocalPerformance(engine.tierHealth.get(account.id)?.localPerformance) }
        : {}),
      models: (account.availableModels || [{ id: account.model, name: account.model }])
        .filter(model => typeof model?.id === 'string')
        .map(model => ({ id: model.id, name: model.name || model.id }))
    }))
  };
}

function createAccountChainApi(engine, { isOriginAllowed = () => false } = {}) {
  if (!engine || !Array.isArray(engine.chain?.accounts)) throw new TypeError('An account engine is required.');
  return function handleAccountChain(req, res, pathname) {
    if (pathname === '/api/v1/account-chain' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(accountChainSnapshot(engine)));
      return true;
    }
    const isReorder = pathname === '/api/v1/account-chain/reorder';
    const isLimits = pathname === '/api/v1/account-chain/limits';
    if ((!isReorder && !isLimits) || req.method !== 'POST') return false;

    // Permit the same-origin local dashboard and native clients; reject other browser origins.
    if (req.headers.origin && !isOriginAllowed(req.headers.origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { code: 'browser_origin_forbidden', message: 'Use the native application backend for account-order changes.' } }));
      return true;
    }
    const contentType = String(req.headers['content-type'] || '');
    const isForm = isLimits && /^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType);
    if (!isForm && !/^application\/json(?:\s*;|$)/i.test(contentType)) {
      res.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { code: 'json_required', message: 'Content-Type application/json is required.' } }));
      return true;
    }
    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
      if (body.length + chunk.length > 16 * 1024) { tooLarge = true; return; }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: { code: 'body_too_large', message: 'Request body is limited to 16 KB.' } }));
        return;
      }
      let input;
      try {
        if (isForm) {
          const form = new URLSearchParams(body);
          const allowed = ['thresholdPercent', 'quotaResetHours', 'expectedRevision'];
          input = [...form.keys()].every(key => allowed.includes(key)) && allowed.every(key => form.getAll(key).length === 1)
            ? Object.fromEntries(allowed.map(key => [key, Number(form.get(key))])) : null;
        } else input = JSON.parse(body || '{}');
      } catch { input = null; }
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: { code: 'invalid_json', message: 'A JSON object is required.' } }));
        return;
      }
      try {
        if (isLimits) {
          engine.setRoutingLimits({
            thresholdPercent: Number(input.thresholdPercent),
            quotaResetHours: Number(input.quotaResetHours),
            expectedRevision: Number(input.expectedRevision)
          });
          if (isForm) {
            res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' });
            res.end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: true, snapshot: accountChainSnapshot(engine) }));
          return;
        }
        const result = engine.reorderAccounts(input.accountIds, input.expectedRevision);
        if (isForm) {
          res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, ...result, snapshot: accountChainSnapshot(engine) }));
      } catch (error) {
        const conflict = error.code === 'stale_revision';
        const status = conflict ? 409 : 400;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: { code: error.code || 'invalid_order', message: error.message } }));
      }
    });
    return true;
  };
}

module.exports = { API_VERSION, MODULE_VERSION, accountChainSnapshot, createAccountChainApi };
