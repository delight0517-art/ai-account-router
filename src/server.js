'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { renderDashboard } = require('./dashboard');
const { AccountLibraryEngine } = require('../src/AccountLibraryEngine.js');
const { createAccountChainApi } = require('./account-chain-v1.js');
const { ChatGptOAuthManager } = require('./chatgpt-oauth.js');
const { AntigravityCli } = require('./antigravity-cli.js');
const { SharedAccountCatalog } = require('./shared-account-catalog.js');
const { readGenericPassword, writeGenericPassword, deleteGenericPassword } = require('./keychain.js');
const { isLocalProviderAccount } = require('./AdaptiveLocalRouting.js');

const KEYCHAIN_SERVICE = 'com.rogan.priority-chain-router.provider';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

function keychainCredential(accountId) {
  const credential = readGenericPassword(KEYCHAIN_SERVICE, String(accountId));
  if (!credential) {
    const error = new Error('No provider credential is configured in macOS Keychain.');
    error.code = 'missing_credential';
    throw error;
  }
  return credential;
}

function storeKeychainCredential(accountId, credential) {
  writeGenericPassword(KEYCHAIN_SERVICE, accountId, credential);
}

function deleteKeychainCredential(accountId) {
  deleteGenericPassword(KEYCHAIN_SERVICE, accountId);
}

function completionURL(baseUrl, allowInsecureLocalhost) {
  const url = new URL(baseUrl);
  const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(allowInsecureLocalhost && local && url.protocol === 'http:'))) {
    throw new Error('Provider URL must use HTTPS and cannot contain credentials, query, or fragment.');
  }
  if (!url.pathname.replace(/\/$/, '').endsWith('/chat/completions')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}${url.pathname.replace(/\/$/, '').endsWith('/v1') ? '' : '/v1'}/chat/completions`;
  }
  return url;
}

function responseFailure(responseEvent) {
  const response = responseEvent?.response || {};
  const error = response.error || responseEvent?.error || {};
  const code = typeof error.code === 'string' && /^[a-z0-9_:-]{1,100}$/i.test(error.code)
    ? error.code : responseEvent?.type === 'response.incomplete' ? 'response_incomplete' : 'provider_error';
  const param = typeof error.param === 'string' && /^[a-z0-9_.:-]{1,100}$/i.test(error.param) ? error.param : undefined;
  const message = typeof error.message === 'string'
    ? error.message.replace(/[\r\n\0-\x1f\x7f]/g, ' ').slice(0, 300)
    : 'ChatGPT Responses request did not complete.';
  const status = code === 'subscription_sharing_usage_limit_exceeded' ? 429
    : ['subscription_sharing_user_not_eligible', 'subscription_sharing_route_not_supported',
      'subscription_sharing_unsupported_capability', 'chatpass_v2_scope_not_authorized',
      'chatpass_v2_invalid_authorization_context'].includes(code) ? 403
      : ['subscription_sharing_invalid_user'].includes(code) ? 401
        : 503;
  return { status, error: { code, message, ...(param ? { param } : {}) } };
}

function responsesRequest(body, model, stream) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const instructions = messages
    .filter(message => message?.role === 'system' && typeof message.content === 'string')
    .map(message => message.content)
    .join('\n\n');
  const input = [];
  for (const message of messages) {
    if (['user', 'assistant'].includes(message?.role) && typeof message.content === 'string' && message.content) {
      input.push({ role: message.role, content: message.content });
    }
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const fn = call?.function || {};
        if (typeof call?.id === 'string' && typeof fn.name === 'string') {
          input.push({ type: 'function_call', call_id: call.id, name: fn.name, arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}' });
        }
      }
    }
    if (message?.role === 'tool') {
      if (typeof message.tool_call_id === 'string') {
        input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '') });
      }
    }
  }
  const tools = (Array.isArray(body?.tools) ? body.tools : []).flatMap(tool => {
    const fn = tool?.type === 'function' ? tool.function : null;
    if (!fn || typeof fn.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(fn.name)
      || !fn.parameters || typeof fn.parameters !== 'object' || Array.isArray(fn.parameters)) return [];
    return [{
      type: 'function', name: fn.name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      parameters: fn.parameters,
      ...(typeof fn.strict === 'boolean' ? { strict: fn.strict } : {})
    }];
  });
  let toolChoice;
  if (['auto', 'none', 'required'].includes(body?.tool_choice)) toolChoice = body.tool_choice;
  else if (body?.tool_choice?.type === 'function' && typeof body.tool_choice.function?.name === 'string') {
    toolChoice = { type: 'function', name: body.tool_choice.function.name };
  }
  return {
    model,
    input,
    ...(tools.length ? { tools } : {}),
    ...(toolChoice && tools.length ? { tool_choice: toolChoice } : {}),
    ...(typeof body?.parallel_tool_calls === 'boolean' && tools.length ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
    ...(instructions ? { instructions } : {}),
    ...(Number.isSafeInteger(body?.max_tokens) && body.max_tokens > 0 ? { max_output_tokens: body.max_tokens } : {}),
    store: false,
    stream
  };
}

const FAILOVER_CONTINUATION_INSTRUCTION = 'The previous provider could not continue this request, so you are taking over the same task. Continue from the complete conversation and prior tool results below. Do not repeat completed work; use the latest user instruction and continue the remaining steps.';

function withFailoverContinuity(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (messages.some(message => message?.role === 'system' && message.content === FAILOVER_CONTINUATION_INSTRUCTION)) return body;
  const firstUserIndex = messages.findIndex(message => message?.role === 'user');
  const insertionIndex = firstUserIndex < 0 ? messages.length : firstUserIndex;
  return { ...body, messages: [...messages.slice(0, insertionIndex), { role: 'system', content: FAILOVER_CONTINUATION_INSTRUCTION }, ...messages.slice(insertionIndex)] };
}

class OpenRouterCompatibleServer {
  constructor(options = {}) {
    this.port = options.port ?? 18880;
    this.engine = new AccountLibraryEngine(options);
    this.isAllowedOrigin = origin => [
      `http://127.0.0.1:${this.port}`,
      `http://localhost:${this.port}`
    ].includes(origin);
    this.accountChainApi = createAccountChainApi(this.engine, { isOriginAllowed: this.isAllowedOrigin });
    this.server = null;
    this.fetch = options.fetch || globalThis.fetch;
    this.getCredential = options.getCredential || keychainCredential;
    this.storeCredential = options.storeCredential || storeKeychainCredential;
    this.deleteCredential = options.deleteCredential || deleteKeychainCredential;
    this.chatGptOAuth = options.chatGptOAuth || new ChatGptOAuthManager({ fetch: this.fetch, configDir: this.engine.configDir });
    this.antigravity = options.antigravity || new AntigravityCli(options.antigravityOptions);
    this.sharedAccountCatalog = options.sharedAccountCatalog || new SharedAccountCatalog({
      configDir: this.engine.configDir,
      sharedDirectory: options.sharedAccountsDir,
      platform: options.platform,
      homedir: options.homedir,
      env: options.env
    });
    this.openAntigravity = options.openAntigravity || (() => this.antigravity.openForSignIn());
    this.allowInsecureLocalhost = options.allowInsecureLocalhost === true;
  }

  _recordProviderResponse(account, response, latencyMs = 0) {
    const health = this.engine.tierHealth.get(account.id);
    if (!health) return;
    health.requestState = response.ok ? 'available' : [401, 403].includes(response.status) ? 'authentication_required' : 'provider_error';
    health.lastRequestAt = Date.now();
    if (isLocalProviderAccount(account) && ![401, 403].includes(response.status)) {
      this.engine.recordLocalPerformance(account.id, response.ok, latencyMs);
    }
    const percentages = [];
    let resetMs = 0;
    for (const dimension of ['requests', 'tokens', 'project-tokens']) {
      const remaining = response.headers.get(`x-ratelimit-remaining-${dimension}`);
      const limit = response.headers.get(`x-ratelimit-limit-${dimension}`);
      if (remaining !== null && limit !== null && Number.isFinite(Number(remaining)) && Number(limit) > 0) {
        percentages.push(100 * Number(remaining) / Number(limit));
        const reset = response.headers.get(`x-ratelimit-reset-${dimension}`) || '';
        let duration = 0;
        for (const part of reset.matchAll(/([\d.]+)(ms|s|m|h)/g)) duration += Number(part[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[part[2]]);
        resetMs = Math.max(resetMs, duration);
      }
    }
    if (percentages.length || response.status === 429) {
      if (response.status === 429) resetMs = Math.max(resetMs, (Number(response.headers.get('retry-after')) || 60) * 1000);
      health.quotaResetAt = resetMs ? Date.now() + resetMs : null;
      health.quotaSource = 'provider-rate-limit-headers';
      this.engine.updateAccountQuota(account.id, response.status === 429 ? 0 : Math.min(...percentages));
    } else this.engine._save();
  }

  async _forwardChatGptPlan(account, body, res) {
    const accessToken = await this.chatGptOAuth.accessToken(account.credentialRef || account.id);
    const stream = body?.stream === true;
    const upstream = await this.fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      // Sign in with ChatGPT plan usage requires store:false and stream:true,
      // even when this OpenAI-compatible client asks Router for a JSON reply.
      body: JSON.stringify(responsesRequest(body, account.model, true)),
      signal: AbortSignal.timeout(120000)
    });
    if (!upstream.ok) {
      this._recordProviderResponse(account, upstream);
      return upstream;
    }
    if (!upstream.body) {
      const failed = new Response(JSON.stringify({ error: { code: 'response_stream_missing', message: 'ChatGPT Responses did not return a stream.' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
      this._recordProviderResponse(account, failed);
      return failed;
    }

    if (!stream) {
      const decoder = new TextDecoder();
      let buffered = '';
      let content = '';
      let response = null;
      let failure = null;
      const streamedToolCalls = new Map();
      for await (const chunk of upstream.body) {
        buffered += decoder.decode(chunk, { stream: true });
        const events = buffered.split('\n\n');
        buffered = events.pop() || '';
        for (const eventBlock of events) {
          const data = eventBlock.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (!data || data === '[DONE]') continue;
          let event;
          try { event = JSON.parse(data); } catch { continue; }
          if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') content += event.delta;
          if (event.type === 'response.output_item.added' && event.item?.type === 'function_call' && Number.isInteger(event.output_index)) {
            streamedToolCalls.set(event.output_index, { ...event.item, arguments: typeof event.item.arguments === 'string' ? event.item.arguments : '' });
          }
          if (event.type === 'response.function_call_arguments.delta' && Number.isInteger(event.output_index) && typeof event.delta === 'string') {
            const item = streamedToolCalls.get(event.output_index);
            if (item) item.arguments += event.delta;
          }
          if (event.type === 'response.function_call_arguments.done' && Number.isInteger(event.output_index) && typeof event.arguments === 'string') {
            const item = streamedToolCalls.get(event.output_index);
            if (item) item.arguments = event.arguments;
          }
          if (event.type === 'response.output_item.done' && event.item?.type === 'function_call' && Number.isInteger(event.output_index)) {
            streamedToolCalls.set(event.output_index, event.item);
          }
          if (event.type === 'response.completed') response = event.response || {};
          if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) failure = responseFailure(event);
        }
        if (failure) break;
      }
      if (failure || !response) {
        const diagnostic = failure || { status: 503, error: { code: 'response_stream_incomplete', message: 'ChatGPT Responses ended before response.completed.' } };
        const failed = new Response(JSON.stringify({ error: diagnostic.error }), {
          status: diagnostic.status,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
        this._recordProviderResponse(account, failed);
        return failed;
      }
      const responseOutput = Array.isArray(response.output) && response.output.length
        ? response.output
        : [...streamedToolCalls.entries()].sort(([left], [right]) => left - right).map(([, item]) => item);
      const toolCalls = responseOutput
        .filter(item => item?.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string')
        .map(item => ({ id: item.call_id, type: 'function', function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : '{}' } }));
      if (!content && !toolCalls.length) {
        const failed = new Response(JSON.stringify({ error: {
          code: 'response_empty',
          message: 'ChatGPT completed the request without text or a tool call. Check the signed-in account and model availability.'
        } }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
        this._recordProviderResponse(account, failed);
        return failed;
      }
      this._recordProviderResponse(account, upstream);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        id: response.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: account.model,
        router: { accountId: account.id, rank: account.tier, model: account.model },
        choices: [{ index: 0, message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
        usage: response.usage || undefined
      }));
      return null;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const decoder = new TextDecoder();
    let buffered = '';
    let responseId = `chatcmpl-${Date.now()}`;
    let completed = false;
    const toolCallIndexes = new Set();
    const toolArgumentIndexes = new Set();
    const emitToolCall = (index, item, argumentsDelta = '') => {
      if (!Number.isInteger(index) || index < 0 || !item || typeof item.call_id !== 'string' || typeof item.name !== 'string') return;
      const first = !toolCallIndexes.has(index);
      toolCallIndexes.add(index);
      if (argumentsDelta) toolArgumentIndexes.add(index);
      const functionDelta = first
        ? { id: item.call_id, type: 'function', function: { name: item.name, arguments: argumentsDelta } }
        : { function: { arguments: argumentsDelta } };
      res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: account.model, choices: [{ index: 0, delta: { tool_calls: [{ index, ...functionDelta }] }, finish_reason: null }] })}\n\n`);
    };
    for await (const chunk of upstream.body) {
      buffered += decoder.decode(chunk, { stream: true });
      const events = buffered.split('\n\n');
      buffered = events.pop() || '';
      for (const eventBlock of events) {
        const data = eventBlock.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (!data || data === '[DONE]') continue;
        let event;
        try { event = JSON.parse(data); } catch { continue; }
        if (event.response?.id) responseId = event.response.id;
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: account.model, choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }] })}\n\n`);
        }
        if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
          emitToolCall(event.output_index, event.item);
        }
        if (event.type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
          const outputIndex = event.output_index;
          if (Number.isInteger(outputIndex)) {
            const item = event.item || {};
            const index = toolCallIndexes.has(outputIndex) ? outputIndex : outputIndex;
            if (event.delta) toolArgumentIndexes.add(index);
            res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: account.model, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: event.delta } }] }, finish_reason: null }] })}\n\n`);
          }
        }
        if (event.type === 'response.completed') {
          completed = true;
          const output = Array.isArray(event.response?.output) ? event.response.output : [];
          output.forEach((item, outputIndex) => {
            if (item?.type === 'function_call' && !toolCallIndexes.has(outputIndex)) emitToolCall(outputIndex, item, typeof item.arguments === 'string' ? item.arguments : '{}');
            else if (item?.type === 'function_call' && !toolArgumentIndexes.has(outputIndex) && typeof item.arguments === 'string' && item.arguments) {
              res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: account.model, choices: [{ index: 0, delta: { tool_calls: [{ index: outputIndex, function: { arguments: item.arguments } }] }, finish_reason: null }] })}\n\n`);
            }
          });
        }
        if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
          const diagnostic = responseFailure(event);
          this._recordProviderResponse(account, new Response(JSON.stringify({ error: diagnostic.error }), { status: diagnostic.status }));
          res.write(`data: ${JSON.stringify({ error: diagnostic.error })}\n\n`);
          res.end('data: [DONE]\n\n');
          return null;
        }
      }
    }
    if (!completed) {
      const diagnostic = { status: 503, error: { code: 'response_stream_incomplete', message: 'ChatGPT Responses ended before response.completed.' } };
      this._recordProviderResponse(account, new Response(JSON.stringify({ error: diagnostic.error }), { status: diagnostic.status }));
      res.write(`data: ${JSON.stringify({ error: diagnostic.error })}\n\n`);
      res.end('data: [DONE]\n\n');
      return null;
    }
    this._recordProviderResponse(account, upstream);
    res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: account.model, choices: [{ index: 0, delta: {}, finish_reason: toolCallIndexes.size ? 'tool_calls' : 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
    return null;
  }

  async _forwardAntigravity(account, body, res) {
    const messages = Array.isArray(body?.messages) ? body.messages.flatMap(message => {
      if (['system', 'user', 'assistant'].includes(message?.role) && typeof message.content === 'string') {
        const result = message.content ? [{ role: message.role, content: message.content }] : [];
        if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
          for (const call of message.tool_calls) result.push({ role: 'assistant', content: `[Prior tool call ${String(call?.function?.name || 'unknown')}: ${String(call?.function?.arguments || '{}')}]` });
        }
        return result;
      }
      if (message?.role === 'tool') return [{ role: 'user', content: `[Prior tool result ${String(message.name || message.tool_call_id || 'tool')}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')}]` }];
      return [];
    }) : [];
    let streamed = false;
    const stream = body?.stream === true;
    const responseId = `chatcmpl-${Date.now()}`;
    const result = await this.antigravity.complete(account.model, messages, {
      onText: text => {
        if (!stream) return;
        if (!streamed) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          streamed = true;
        }
        res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: account.model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
      }
    });
    if (stream) {
      if (!streamed) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: account.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
      return null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ id: `chatcmpl-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: account.model, choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }], usage: result.usage }));
    return null;
  }

  _readJson(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try { resolve(JSON.parse(body || '{}')); }
        catch (err) { resolve({}); }
      });
      req.on('error', reject);
    });
  }

  _readBoundedJson(req, limit = 16 * 1024) {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;
      let tooLarge = false;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > limit) { tooLarge = true; return; }
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        if (tooLarge) {
          const error = new Error('Request body is too large.');
          error.code = 'body_too_large';
          reject(error);
          return;
        }
        try {
          const parsed = JSON.parse(body || '{}');
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
          resolve(parsed);
        } catch {
          const error = new Error('A JSON object is required.');
          error.code = 'invalid_json';
          reject(error);
        }
      });
      req.on('error', reject);
    });
  }

  _registerProviderAccount(input) {
    const id = typeof input?.id === 'string' ? input.id.trim() : '';
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    const model = typeof input?.model === 'string' ? input.model.trim() : '';
    const credential = typeof input?.credential === 'string' ? input.credential.trim() : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw Object.assign(new Error('Use a unique account ID with letters, numbers, dot, underscore, or hyphen.'), { status: 400, code: 'invalid_account_id' });
    if (!name || name.length > 80 || !model || model.length > 120) throw Object.assign(new Error('Account name and model are required and must fit the displayed limits.'), { status: 400, code: 'invalid_profile' });
    const localProvider = input.provider === 'local-openai-compatible';
    if (!['openai-compatible', 'local-openai-compatible'].includes(input.provider)) throw Object.assign(new Error('Choose a supported OpenAI-compatible provider.'), { status: 400, code: 'unsupported_provider' });
    if ((!localProvider && !credential) || credential.length > 4096 || /[\r\n\0]/.test(credential)) {
      throw Object.assign(new Error(localProvider ? 'The optional local API key is invalid.' : 'Enter a valid provider API key.'), { status: 400, code: 'invalid_credential' });
    }
    if (this.engine.chain.accounts.some(account => account.id === id)) throw Object.assign(new Error('That account ID already exists. Choose another ID.'), { status: 409, code: 'duplicate_account_id' });

    let providerUrl;
    try { providerUrl = new URL(input.baseUrl); } catch { providerUrl = null; }
    const loopback = providerUrl && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(providerUrl.hostname);
    const validProtocol = localProvider
      ? loopback && ['http:', 'https:'].includes(providerUrl.protocol)
      : providerUrl?.protocol === 'https:';
    if (!providerUrl || !validProtocol || providerUrl.username || providerUrl.password || providerUrl.search || providerUrl.hash) {
      throw Object.assign(new Error(localProvider
        ? 'Local provider URLs must use HTTP or HTTPS on 127.0.0.1, localhost, or ::1.'
        : 'Provider URL must be a valid HTTPS URL without credentials, query, or fragment.'), { status: 400, code: 'invalid_provider_url' });
    }

    const account = {
      id,
      name,
      provider: localProvider ? 'local-openai-compatible' : 'openai-compatible',
      model,
      baseUrl: providerUrl.toString().replace(/\/+$/, ''),
      ...(credential ? { credentialRef: id } : {}),
      enabled: true
    };
    const previousChain = JSON.parse(JSON.stringify(this.engine.chain));
    this.engine.upsertAccount(account);
    try {
      if (credential) this.storeCredential(id, credential);
    } catch {
      this.engine.chain = previousChain;
      this.engine.tierHealth.delete(id);
      this.engine._save(previousChain);
      this.engine._initHealthStates();
      throw Object.assign(new Error('Provider key could not be saved to macOS Keychain; the profile was rolled back.'), { status: 503, code: 'keychain_write_failed' });
    }
    return { id, name, provider: account.provider, model, tier: this.engine.chain.accounts.find(item => item.id === id)?.tier };
  }

  start() {
    return new Promise((resolve) => {
      this.server = http.createServer(async (req, res) => {
        const host = String(req.headers.host || '').toLowerCase();
        const allowedHosts = new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`]);
        if (!allowedHosts.has(host)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: 'Invalid local host.' }));
          return;
        }
        const origin = String(req.headers.origin || '').replace(/\/$/, '').toLowerCase();
        if (origin && origin !== `http://${host}`) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: { code: 'browser_origin_forbidden', message: 'Cross-origin access is not allowed.' } }));
          return;
        }
        const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
        const pathname = url.pathname;

        if (pathname === '/dashboard.css' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.end(fs.readFileSync(path.join(__dirname, 'dashboard.css')));
          return;
        }

        if (this.accountChainApi(req, res, pathname)) return;

        if (origin) res.setHeader('Access-Control-Allow-Origin', `http://${host}`);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        // 1. OpenAI / OpenRouter 호환 엔드포인트: /v1/models
        if (pathname === '/v1/models' && req.method === 'GET') {
          const status = this.engine.getStatus();
          const models = status.accounts.filter(acc => status.enabled && acc.enabled && acc.provider !== 'demo' && acc.baseUrl && acc.model).map(acc => ({
            id: `${acc.provider}/${acc.model || 'auto'}@${acc.id}`,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: acc.provider || 'local-chain',
            active: acc.id === status.activeAccount?.id
          }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: models }));
          return;
        }

        // 2. OpenAI / OpenRouter 호환 엔드포인트: /v1/chat/completions
        if (pathname === '/v1/chat/completions' && req.method === 'POST') {
          let body;
          try { body = await this._readJson(req); }
          catch {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { code: 'invalid_request', message: 'A valid JSON request body is required.' } }));
            return;
          }
          const attempted = new Set();
          const preferredModel = this.engine.chain.accounts.some(account => account.model === body.model
            || account.availableModels?.some(model => model.id === body.model)) ? body.model : null;
          let lastCode = 'provider_unconfigured';
          let lastParam = null;
          while (!res.destroyed) {
            const selected = this.engine.resolveActiveAccount(null, [...attempted], preferredModel, body);
            const active = selected && preferredModel ? { ...selected, model: preferredModel } : selected;
            if (!active) break;
            attempted.add(active.id);
            const routedBody = attempted.size > 1 ? withFailoverContinuity(body) : body;
            const requestStartedAt = Date.now();
            try {
              const missingEndpoint = !['chatgpt-plan', 'antigravity-cli'].includes(active.provider) && !active.baseUrl;
              if (!this.engine.chain.enabled || active.enabled === false || active.provider === 'demo' || !active.model || missingEndpoint) {
                const error = new Error('Provider profile is not configured.');
                error.code = 'provider_unconfigured';
                throw error;
              }
              let upstream;
              if (active.provider === 'chatgpt-plan') {
                upstream = await this._forwardChatGptPlan(active, routedBody, res);
                if (!upstream) return;
              } else if (active.provider === 'antigravity-cli') {
                await this._forwardAntigravity(active, routedBody, res);
                return;
              } else {
                const localProvider = isLocalProviderAccount(active);
                const url = completionURL(active.baseUrl, this.allowInsecureLocalhost || localProvider);
                const credential = active.credentialRef
                  ? this.getCredential(active.credentialRef || active.id)
                  : localProvider ? '' : this.getCredential(active.id);
                const headers = { 'Content-Type': 'application/json' };
                if (credential) headers.Authorization = `Bearer ${credential}`;
                upstream = await this.fetch(url, {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({ ...routedBody, model: active.model }),
                  signal: AbortSignal.timeout(120000)
                });
              }
              this._recordProviderResponse(active, upstream, Date.now() - requestStartedAt);
              if (!upstream.ok) {
                const diagnostic = await upstream.clone().json().catch(() => null);
                const providerCode = diagnostic?.error?.code;
                const providerParam = diagnostic?.error?.param;
                lastCode = upstream.status === 429 ? 'provider_quota'
                  : typeof providerCode === 'string' && /^[a-z0-9_:-]{1,100}$/i.test(providerCode)
                    ? providerCode : 'provider_error';
                lastParam = typeof providerParam === 'string' && /^[a-z0-9_.:-]{1,100}$/i.test(providerParam)
                  ? providerParam : null;
                await upstream.body?.cancel();
                continue;
              }
              res.writeHead(upstream.status, {
                'Content-Type': upstream.headers.get('content-type') || 'application/json',
                'Cache-Control': 'no-store'
              });
              if (upstream.body) {
                for await (const chunk of upstream.body) {
                  if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve));
                }
              }
              res.end();
              return;
            } catch (error) {
              if (res.headersSent) {
                res.destroy(error);
                return;
              }
              lastCode = error.code || 'provider_unavailable';
              if (isLocalProviderAccount(active) && !['missing_credential', 'provider_auth_failed'].includes(lastCode)) {
                this.engine.recordLocalPerformance(active.id, false, Date.now() - requestStartedAt);
              }
              if (['missing_credential', 'provider_auth_failed'].includes(lastCode)) {
                const health = this.engine.tierHealth.get(active.id);
                if (health) { health.requestState = 'authentication_required'; this.engine._save(); }
              }
            }
          }
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: { code: lastCode, ...(lastParam ? { param: lastParam } : {}), message: 'No configured provider account could complete this request.' } }));
          return;
        }

        // 3. ChatGPT OAuth account connection. The provider page may use Google sign-in.
        if (pathname === '/api/oauth/chatgpt/start' && req.method === 'POST') {
          const reply = (status, value) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(value));
          };
          if (!this.isAllowedOrigin(origin)) {
            reply(403, { error: { code: 'browser_origin_forbidden', message: 'ChatGPT sign-in can start only from the local Router dashboard.' } });
            return;
          }
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
            reply(415, { error: { code: 'json_required', message: 'Content-Type application/json is required.' } });
            return;
          }
          let input;
          try { input = await this._readBoundedJson(req); }
          catch (error) {
            reply(error.code === 'body_too_large' ? 413 : 400, { error: { code: error.code || 'invalid_json', message: error.message } });
            return;
          }
          const accountId = typeof input.id === 'string' ? input.id.trim() : '';
          const name = typeof input.name === 'string' ? input.name.trim() : '';
          const model = typeof input.model === 'string' ? input.model.trim() : '';
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(accountId) || !name || name.length > 80 || model.length > 120) {
            reply(400, { error: { code: 'invalid_profile', message: 'Enter a unique account ID and display name.' } });
            return;
          }
          if (this.engine.chain.accounts.some(account => account.id === accountId)) {
            reply(409, { error: { code: 'duplicate_account_id', message: 'That account ID already exists.' } });
            return;
          }
          try {
            const result = await this.chatGptOAuth.start({
              accountId,
              name,
              model,
              redirectUri: `http://127.0.0.1:${this.port}/auth/chatgpt/callback`
            });
            reply(202, {
              ok: true,
              state: result.state,
              authorizationUrl: result.authorizationUrl,
              opened: result.opened,
              openError: result.openError
            });
          } catch (error) {
            reply(503, { error: { code: 'oauth_start_failed', message: error.message || 'ChatGPT sign-in could not start.' } });
          }
          return;
        }

        if (pathname === '/auth/chatgpt/callback' && req.method === 'GET') {
          try {
            const completed = await this.chatGptOAuth.complete(url);
            try {
              this.engine.upsertAccount(completed.profile);
              this.sharedAccountCatalog.sync(this.engine.chain.accounts);
            } catch (error) {
              await this.chatGptOAuth.disconnect(completed.profile.id);
              this.chatGptOAuth.fail(completed.state, error.message || 'The local account profile could not be saved.');
              throw error;
            }
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
              'X-Frame-Options': 'DENY',
              'X-Content-Type-Options': 'nosniff',
              'Referrer-Policy': 'no-referrer'
            });
            res.end('<!doctype html><html lang="ko"><meta charset="utf-8"><title>AI Account Router</title><p>ChatGPT 계정 연결이 완료되었습니다. AI Account Router로 돌아가면 계정이 추가됩니다. 이 탭을 닫아도 됩니다.</p></html>');
          } catch (error) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
            res.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>AI Account Router</title><p>${escapeHtml(error.message || '계정 연결을 완료하지 못했습니다.')}</p></html>`);
          }
          return;
        }

        if (pathname === '/api/oauth/chatgpt/status' && req.method === 'GET') {
          const state = url.searchParams.get('state') || '';
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(this.chatGptOAuth.status(state)));
          return;
        }

        if (pathname === '/api/oauth/chatgpt/cancel' && req.method === 'POST') {
          const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
          if (!this.isAllowedOrigin(origin)) return reply(403, { error: { code: 'browser_origin_forbidden', message: 'ChatGPT sign-in can be canceled only from the local Router dashboard.' } });
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reply(415, { error: { code: 'json_required', message: 'Content-Type application/json is required.' } });
          let input;
          try { input = await this._readBoundedJson(req); }
          catch (error) { return reply(error.code === 'body_too_large' ? 413 : 400, { error: { code: error.code || 'invalid_json', message: error.message } }); }
          const state = typeof input.state === 'string' ? input.state : '';
          if (!/^[A-Za-z0-9_-]{32,128}$/.test(state)) return reply(400, { error: { code: 'invalid_oauth_state', message: 'A valid pending sign-in state is required.' } });
          const result = this.chatGptOAuth.cancel(state);
          if (!result.ok && !result.canceled) return reply(409, { error: { code: 'oauth_not_pending', message: result.message } });
          return reply(200, result);
        }

        if (pathname === '/api/antigravity/open' && req.method === 'POST') {
          const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
          if (!this.isAllowedOrigin(origin)) return reply(403, { error: { code: 'browser_origin_forbidden', message: 'Antigravity sign-in can start only from the local Router dashboard.' } });
          try { this.openAntigravity(); reply(200, { ok: true }); }
          catch (error) { reply(error.status || 503, { error: { code: error.code || 'antigravity_open_failed', message: error.message } }); }
          return;
        }

        if (pathname === '/api/antigravity/refresh' && req.method === 'POST') {
          const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
          if (!this.isAllowedOrigin(origin)) return reply(403, { error: { code: 'browser_origin_forbidden', message: 'Antigravity profiles can be refreshed only from the local Router dashboard.' } });
          let input = {};
          try { input = await this._readBoundedJson(req); } catch {}
          const accountId = (typeof input?.id === 'string' && input.id.trim()) ? input.id.trim() : 'antigravity-google';
          const accountName = (typeof input?.name === 'string' && input.name.trim()) ? input.name.trim() : 'Antigravity Google account';
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(accountId)) {
            return reply(400, { error: { code: 'invalid_account_id', message: 'Use a valid account ID.' } });
          }
          try {
            const models = this.antigravity.listModels();
            const current = this.engine.chain.accounts.find(account => account.id === accountId);
            const selected = models.find(model => model.id === current?.model) || models[0];
            const profile = { id: accountId, name: accountName, provider: 'antigravity-cli', model: selected.id, baseUrl: 'antigravity://cli', credentialRef: accountId, availableModels: models, enabled: true };
            this.engine.upsertAccount(profile);
            this.sharedAccountCatalog.sync(this.engine.chain.accounts);
            reply(200, { ok: true, account: profile, models, revision: this.engine.chain.revision ?? 0 });
          } catch (error) { reply(503, { error: { code: error.code || 'antigravity_model_list_failed', message: error.message } }); }
          return;
        }

        if (pathname === '/api/shared-accounts' && req.method === 'GET') {
          if (origin && !this.isAllowedOrigin(origin)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: { code: 'browser_origin_forbidden', message: 'Shared account identities can be read only from the local Router dashboard.' } }));
            return;
          }
          const result = this.sharedAccountCatalog.sync(this.engine.chain.accounts);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(result));
          return;
        }

        if (pathname.startsWith('/api/accounts/') && pathname.endsWith('/models') && req.method === 'GET') {
          const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
          if (origin && !this.isAllowedOrigin(origin)) return reply(403, { error: { code: 'browser_origin_forbidden', message: 'Model lists can be read only from the local Router dashboard.' } });
          let accountId;
          try { accountId = decodeURIComponent(pathname.slice('/api/accounts/'.length, -'/models'.length)); } catch { accountId = ''; }
          const account = this.engine.chain.accounts.find(item => item.id === accountId);
          if (!account || !['chatgpt-plan', 'antigravity-cli'].includes(account.provider)) return reply(404, { error: { code: 'account_not_found', message: 'The provider account was not found.' } });
          try {
            const models = account.provider === 'chatgpt-plan' ? await this.chatGptOAuth.listModels(account.credentialRef || account.id) : this.antigravity.listModels();
            this.engine.upsertAccount({ ...account, availableModels: models });
            reply(200, { ok: true, accountId, models });
          } catch (error) { reply(503, { error: { code: error.code || 'model_list_failed', message: error.message } }); }
          return;
        }

        if (pathname.startsWith('/api/accounts/') && pathname.endsWith('/reconnect') && req.method === 'POST') {
          const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
          if (!this.isAllowedOrigin(origin)) return reply(403, { error: { code: 'browser_origin_forbidden', message: 'ChatGPT sign-in can start only from the local Router dashboard.' } });
          let accountId;
          try { accountId = decodeURIComponent(pathname.slice('/api/accounts/'.length, -'/reconnect'.length)); } catch { accountId = ''; }
          const account = this.engine.chain.accounts.find(item => item.id === accountId && item.provider === 'chatgpt-plan');
          if (!account) return reply(404, { error: { code: 'account_not_found', message: 'The ChatGPT account was not found.' } });
          try {
            const result = await this.chatGptOAuth.start({
              accountId: account.id,
              name: account.name,
              model: account.model,
              reconnect: true,
              redirectUri: `http://127.0.0.1:${this.port}/auth/chatgpt/callback`
            });
            reply(202, { ok: true, state: result.state });
          } catch (error) {
            reply(503, { error: { code: error.code || 'oauth_start_failed', message: error.message || 'ChatGPT sign-in could not start.' } });
          }
          return;
        }

        if (pathname.startsWith('/api/accounts/') && pathname.endsWith('/model') && req.method === 'POST') {
          const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
          if (!this.isAllowedOrigin(origin)) return reply(403, { error: { code: 'browser_origin_forbidden', message: 'Model selection can be saved only from the local Router dashboard.' } });
          let accountId;
          try { accountId = decodeURIComponent(pathname.slice('/api/accounts/'.length, -'/model'.length)); } catch { accountId = ''; }
          const account = this.engine.chain.accounts.find(item => item.id === accountId);
          if (!account || !['chatgpt-plan', 'antigravity-cli'].includes(account.provider)) return reply(404, { error: { code: 'account_not_found', message: 'The provider account was not found.' } });
          let input;
          try { input = await this._readBoundedJson(req); } catch (error) { return reply(400, { error: { code: 'invalid_json', message: error.message } }); }
          const model = typeof input.model === 'string' ? input.model : '';
          if (!Array.isArray(account.availableModels) || !account.availableModels.some(item => item.id === model)) return reply(400, { error: { code: 'model_unavailable', message: 'Choose a model listed for this account, then refresh the list if needed.' } });
          this.engine.upsertAccount({ ...account, model });
          reply(200, { ok: true, accountId, model, revision: this.engine.chain.revision ?? 0 });
          return;
        }

        // 4. 계정 라이브러리 관리 엔드포인트: /api/accounts
        if (pathname === '/api/accounts' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.engine.getStatus()));
          return;
        }

        if (pathname === '/api/accounts' && req.method === 'POST') {
          const reply = (status, value) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(value));
          };
          if (!this.isAllowedOrigin(origin)) {
            reply(403, { error: { code: 'browser_origin_forbidden', message: 'Provider profiles can be added only from the local Router dashboard.' } });
            return;
          }
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
            reply(415, { error: { code: 'json_required', message: 'Content-Type application/json is required.' } });
            return;
          }
          let input;
          try { input = await this._readBoundedJson(req); }
          catch (error) {
            const status = error.code === 'body_too_large' ? 413 : 400;
            reply(status, { error: { code: error.code || 'invalid_json', message: error.message } });
            return;
          }
          try {
            const account = this._registerProviderAccount(input);
            this.sharedAccountCatalog.sync(this.engine.chain.accounts);
            reply(201, { ok: true, account, revision: this.engine.chain.revision ?? 0 });
          } catch (error) {
            reply(error.status || 503, { error: { code: error.code || 'profile_registration_failed', message: error.message || 'Provider profile registration failed.' } });
          }
          return;
        }

        if (pathname.startsWith('/api/accounts/') && req.method === 'DELETE') {
          const reply = (status, value) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(value));
          };
          if (!this.isAllowedOrigin(origin)) {
            reply(403, { error: { code: 'browser_origin_forbidden', message: 'Accounts can be disconnected only from the local Router dashboard.' } });
            return;
          }
          let accountId;
          try { accountId = decodeURIComponent(pathname.slice('/api/accounts/'.length)); }
          catch { accountId = ''; }
          const account = this.engine.chain.accounts.find(item => item.id === accountId);
          if (!account || account.provider === 'demo') {
            reply(404, { error: { code: 'account_not_found', message: 'The connected account was not found.' } });
            return;
          }
          if (account.provider === 'chatgpt-plan') await this.chatGptOAuth.disconnect(accountId);
          else if (account.provider !== 'antigravity-cli') this.deleteCredential(account.credentialRef || accountId);
          this.engine.removeAccount(accountId);
          this.sharedAccountCatalog.sync(this.engine.chain.accounts);
          reply(200, { ok: true, revision: this.engine.chain.revision ?? 0 });
          return;
        }

        // 5. 쿼터 보고 및 자동 전환 엔드포인트: /api/accounts/quota
        if (pathname === '/api/accounts/quota' && req.method === 'POST') {
          const body = await this._readJson(req);
          const { accountId, remainingPercent } = body;
          this.engine.updateAccountQuota(accountId, remainingPercent);
          const active = this.engine.resolveActiveAccount();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, activeAccount: active, status: this.engine.getStatus() }));
          return;
        }

        // 6. 대시보드 Web UI
        if (pathname === '/' && req.method === 'GET') {
          const status = this.engine.getStatus();
          const sharedAccounts = this.sharedAccountCatalog.sync(this.engine.chain.accounts);
          const configured = status.accounts.some(acc => acc.enabled && acc.provider !== 'demo' && acc.model && acc.baseUrl);
          const nonce = crypto.randomBytes(18).toString('base64');
          const page = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>Local Account Library & Chain Router</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #181512; color: #f5efe6; margin: 0; padding: 24px; }
    h1 { color: #f06a35; margin-bottom: 8px; }
    .subtitle { color: #bfaea0; margin-bottom: 24px; font-size: 14px; }
    .card { background: #25201b; border: 1px solid #3d352e; border-radius: 12px; padding: 20px; margin-bottom: 20px; max-width: 720px; }
    .active-badge { background: #f06a35; color: #fff; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; }
    .account-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid #332b25; }
    .btn { background: #3d352e; color: #f5efe6; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
    #oauth-cancel[hidden] { display: none; }
    .btn:hover { background: #f06a35; color: #fff; }
    .btn:disabled { opacity: .45; cursor: default; }
    .btn-danger { background: #7f1d1d; }
    .endpoint-box { background: #12100e; padding: 12px; border-radius: 8px; font-family: monospace; font-size: 13px; color: #d4884e; margin-top: 8px; }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .form-grid input { box-sizing: border-box; width: 100%; background: #12100e; color: #f5efe6; border: 1px solid #51463b; border-radius: 7px; padding: 10px; }
    .form-grid input:focus { outline: 2px solid #f06a35; outline-offset: 1px; }
    .form-wide { grid-column: 1 / -1; }
    .field label { display: block; margin-bottom: 5px; color: #d7c9bd; font-size: 13px; }
    .field-hint { color: #bfaea0; font-size: 12px; margin: 5px 0 0; }
    .model-picker { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; color: #d7c9bd; font-size: 12px; }
    .model-picker select { max-width: 360px; background: #12100e; color: #f5efe6; border: 1px solid #51463b; border-radius: 7px; padding: 7px; }
    .status-message { min-height: 1.2em; color: #f0b37e; }
  </style>
  <link rel="stylesheet" href="/dashboard.css">
</head>
<body>
  ${renderDashboard(status, this.port, sharedAccounts)}
  <h1>⚡️ Local Account Library & Priority Engine</h1>
  <div class="subtitle">OpenRouter-compatible OpenAI Endpoint (Port: ${this.port})</div>

  <div class="card">
    <h3>계정 우선순위</h3>
    <div style="font-size: 18px; font-weight: bold; color: #f06a35;">${escapeHtml(status.activeAccount?.name || '없음')}</div>
    <p style="color: #bfaea0; font-size: 13px;">${configured ? 'Provider state: unverified. 실제 요청은 설정한 HTTPS 제공자에 전달되며, HTTP 429 응답에서는 다음 우선순위 계정을 시도합니다.' : '데모 프로필만 있습니다. 제공자 프로필과 Keychain 키가 설정되기 전까지 채팅 요청은 HTTP 503을 반환합니다.'}</p>
  </div>

  <div class="card">
    <h3>등록된 계정 목록 (Priority Tiers)</h3>
    ${status.accounts.map((acc, index) => `
      <div class="account-row">
        <div>
            <b>${acc.tier}순위: ${escapeHtml(acc.name)}</b> (${escapeHtml(acc.model)})
          <div style="font-size: 12px; color: #bfaea0;">${escapeHtml(acc.provider)}${acc.email ? ` · ${escapeHtml(acc.email)}` : ''} · 잔여 쿼터 보고값: ${acc.health?.totalRemainingPercent ?? '100'}%</div>
          ${['chatgpt-plan', 'antigravity-cli'].includes(acc.provider) ? `<div class="model-picker"><label for="model-${escapeHtml(acc.id)}">사용 모델</label><select id="model-${escapeHtml(acc.id)}" data-model-account="${escapeHtml(acc.id)}">${(Array.isArray(acc.availableModels) && acc.availableModels.length ? acc.availableModels : [{ id: acc.model, name: acc.model }]).map(model => `<option value="${escapeHtml(model.id)}" ${model.id === acc.model ? 'selected' : ''}>${escapeHtml(model.name)} · ${escapeHtml(model.id)}</option>`).join('')}</select><button class="btn" data-refresh-models="${escapeHtml(acc.id)}">모델 새로고침</button></div>` : ''}
        </div>
        <div>
          ${acc.id === status.activeAccount?.id ? '<span class="active-badge">현재 활성</span>' : ''}
          <button class="btn" data-move="up" data-account-id="${escapeHtml(acc.id)}" aria-label="${escapeHtml(acc.name)} 위로 이동" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn" data-move="down" data-account-id="${escapeHtml(acc.id)}" aria-label="${escapeHtml(acc.name)} 아래로 이동" ${index === status.accounts.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn btn-danger" data-account-id="${escapeHtml(acc.id)}" data-percent="5">5% 시뮬레이션</button>
          <button class="btn" data-account-id="${escapeHtml(acc.id)}" data-percent="100">100% 시뮬레이션</button>
          ${acc.provider !== 'demo' ? '<button class="btn btn-danger" data-disconnect="true" data-account-id="' + escapeHtml(acc.id) + '">연결 해제</button>' : ''}
        </div>
      </div>
    `).join('')}
    <p id="order-error" class="status-message" aria-live="polite"></p>
  </div>

  <div class="card">
    <h3>ChatGPT 계정 연결</h3>
    <p style="font-size: 13px; color: #bfaea0;">ChatGPT OAuth 화면에서 원하는 계정으로 로그인합니다. 로그인 토큰은 이 Mac의 Keychain에 계정별로 저장하고, 로그인 후 그 계정에 표시 가능한 모델 목록을 불러옵니다.</p>
    <form id="oauth-form" action="/api/oauth/chatgpt/start" method="post">
      <div class="form-grid">
        <div class="field">
          <label for="oauth-id">계정 ID</label>
          <input id="oauth-id" name="id" required maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,127}" value="chatgpt-secondary" autocorrect="off" autocapitalize="off" spellcheck="false" aria-describedby="oauth-id-hint">
          <p id="oauth-id-hint" class="field-hint">다른 계정과 겹치지 않는 로컬 식별자입니다. (예: chatgpt-work, chatgpt-personal)</p>
        </div>
        <div class="field">
          <label for="oauth-name">표시 이름</label>
          <input id="oauth-name" name="name" required maxlength="80" value="ChatGPT 계정">
        </div>
      </div>
      <p id="oauth-error" class="status-message" aria-live="polite"></p>
      <input id="oauth-url" type="url" readonly hidden aria-label="ChatGPT 로그인 URL" style="width:100%;margin:8px 0;">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <button class="btn" type="submit">ChatGPT 로그인</button>
        <button class="btn" id="oauth-cancel" type="button" hidden>로그인 취소 · 새 링크 발급</button>
        <button class="btn" id="oauth-copy-url" type="button" hidden>로그인 URL 복사</button>
      </div>
    </form>
  </div>

  <div class="card">
    <h3>Antigravity Google 계정 연결</h3>
    <p style="font-size: 13px; color: #bfaea0;">공식 Antigravity 앱에서 Google 로그인을 마친 뒤 모델을 새로고침하세요. Router는 Antigravity CLI의 로그인 상태와 모델 목록을 사용하며 OAuth 자격 증명을 복사하지 않습니다.</p>
    <form id="antigravity-form">
      <div class="form-grid">
        <div class="field">
          <label for="antigravity-id">계정 ID</label>
          <input id="antigravity-id" name="id" required maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,127}" value="antigravity-google" autocorrect="off" autocapitalize="off" spellcheck="false" aria-describedby="antigravity-id-hint">
          <p id="antigravity-id-hint" class="field-hint">다른 계정과 겹치지 않는 고유 식별자입니다.</p>
        </div>
        <div class="field">
          <label for="antigravity-name">표시 이름</label>
          <input id="antigravity-name" name="name" required maxlength="80" value="Antigravity 계정">
        </div>
      </div>
      <p id="antigravity-message" class="status-message" aria-live="polite"></p>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button class="btn" id="antigravity-open" type="button">Antigravity 열기 / 로그인</button>
        <button class="btn" id="antigravity-refresh" type="button">로그인 확인 및 모델 가져오기</button>
      </div>
    </form>
  </div>

  <div class="card">
    <h3>OpenAI 호환 제공자 계정 연결</h3>
    <p style="font-size: 13px; color: #bfaea0;">API 키는 이 Mac의 로그인 Keychain에 저장합니다. Router가 외부 제공자에 요청할 때만 키를 사용하고, 계정 목록이나 앱 설정에는 키를 기록하지 않습니다.</p>
    <form id="provider-form" action="/api/accounts" method="post">
      <div class="form-grid">
        <select name="provider" class="form-wide" aria-label="제공자 유형">
          <option value="openai-compatible">외부 OpenAI 호환 제공자</option>
          <option value="local-openai-compatible">이 Mac의 로컬 AI</option>
        </select>
        <input name="id" required maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,127}" placeholder="계정 ID (예: openai-primary)" aria-label="계정 ID">
        <input name="name" required maxlength="80" placeholder="표시 이름" aria-label="표시 이름">
        <input name="model" required maxlength="120" placeholder="모델 ID" aria-label="모델 ID">
        <input name="baseUrl" class="form-wide" type="url" required placeholder="https://api.example.com/v1" aria-label="HTTPS 제공자 URL">
        <input name="credential" class="form-wide" type="password" maxlength="4096" autocomplete="new-password" placeholder="Provider API key" aria-label="Provider API key">
      </div>
      <p class="field-hint" id="provider-local-help">로컬 선택 시 주소는 127.0.0.1, localhost 또는 ::1만 허용합니다. API 키는 선택 사항입니다. 응답 성공률과 지연으로 사용 비중을 자동 조정하며 답변 정확도를 자동 평가하지는 않습니다.</p>
      <p id="provider-error" class="status-message" aria-live="polite"></p>
      <button class="btn" type="submit">계정과 우선순위 항목 추가</button>
    </form>
  </div>

  <div class="card">
    <h3>다른 앱 연동 가이드 (OpenRouter / OpenAI 호환)</h3>
    <p style="font-size: 13px; color: #bfaea0;">클라이언트의 Base URL을 아래 로컬 주소로 설정하세요. Provider 상태는 실제 인증 요청을 성공할 때까지 미확인입니다.</p>
    <div class="endpoint-box">
      Base URL: http://127.0.0.1:${this.port}/v1<br>
      Provider API keys: stored in macOS Keychain
    </div>
  </div>

  <script nonce="${nonce}">
    const accountRevision = ${Number(this.engine.chain.revision ?? 0)};
    const connectModal = document.querySelector('#connect-modal');
    const connectChoices = document.querySelector('#connect-choices');
    const connectPanels = [...document.querySelectorAll('[data-connect-panel]')];
    document.querySelector('#open-connect').addEventListener('click', () => {
      connectChoices.hidden = false;
      connectPanels.forEach(panel => { panel.hidden = true; });
      connectModal.showModal();
    });
    document.querySelector('#close-connect').addEventListener('click', () => connectModal.close());
    connectModal.addEventListener('click', event => { if (event.target === connectModal) connectModal.close(); });
    document.querySelectorAll('[data-connect-choice]').forEach(button => button.addEventListener('click', () => {
      connectChoices.hidden = true;
      connectPanels.forEach(panel => { panel.hidden = panel.dataset.connectPanel !== button.dataset.connectChoice; });
    }));
    document.querySelectorAll('[data-connect-back]').forEach(button => button.addEventListener('click', () => {
      connectChoices.hidden = false;
      connectPanels.forEach(panel => { panel.hidden = true; });
    }));
    [
      ['#oauth-form', '#oauth-form-host'],
      ['#antigravity-open', '#antigravity-form-host'],
      ['#provider-form', '#provider-form-host']
    ].forEach(([selector, hostSelector]) => {
      const element = document.querySelector(selector);
      const host = document.querySelector(hostSelector);
      if (element && host) host.append(element.closest('.card'));
    });
    document.querySelectorAll('[data-menu-trigger]').forEach(button => button.addEventListener('click', () => {
      const menu = document.querySelector('#menu-' + CSS.escape(button.dataset.menuTrigger));
      const opening = menu.hidden;
      document.querySelectorAll('.menu-popover').forEach(item => { item.hidden = true; });
      document.querySelectorAll('[data-menu-trigger]').forEach(item => item.setAttribute('aria-expanded', 'false'));
      menu.hidden = !opening;
      button.setAttribute('aria-expanded', String(opening));
    }));
    document.querySelectorAll('[data-model-owner]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      const row = button.closest('[data-account-row]');
      try {
        const response = await fetch('/api/accounts/' + encodeURIComponent(button.dataset.modelOwner) + '/model', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: button.dataset.model })
        });
        const result = await response.json().catch(() => null);
        if (!response.ok) throw new Error(result?.error?.message || '모델 선택을 저장하지 못했습니다.');
        const modelName = button.querySelector('.model-option-title').textContent;
        row.querySelector('.model-display').textContent = modelName;
        row.querySelectorAll('[data-model-owner]').forEach(option => option.setAttribute('aria-pressed', String(option === button)));
        row.querySelector('.model-save-status').textContent = '선택한 모델을 저장했습니다.';
        const priorityModel = document.querySelector('[data-priority-account="' + CSS.escape(button.dataset.modelOwner) + '"] .priority-model strong');
        if (priorityModel) priorityModel.textContent = button.dataset.model;
      } catch (error) {
        row.querySelector('.model-save-status').textContent = error.message;
      } finally { button.disabled = false; }
    }));
    const orderError = document.querySelector('#order-error');
    const accountSnapshot = ${JSON.stringify(status.accounts.map(({ id, provider }) => ({ id, provider })))};
    document.querySelectorAll('button[data-set-rank]').forEach(button => {
      button.addEventListener('click', async () => {
        const providerIds = accountSnapshot.filter(account => account.provider !== 'demo').map(account => account.id);
        const demoIds = accountSnapshot.filter(account => account.provider === 'demo').map(account => account.id);
        const currentIndex = providerIds.indexOf(button.dataset.accountId);
        const targetRank = Number(button.dataset.setRank);
        if (currentIndex < 0 || !Number.isInteger(targetRank) || targetRank < 1 || targetRank > providerIds.length) return;
        const [accountId] = providerIds.splice(currentIndex, 1);
        providerIds.splice(targetRank - 1, 0, accountId);
        const ids = [...providerIds, ...demoIds];
        button.disabled = true;
        try {
          const response = await fetch('/api/v1/account-chain/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: accountRevision, accountIds: ids }) });
          const result = await response.json().catch(() => null);
          if (!response.ok) throw new Error(result?.error?.message || '우선순위를 저장하지 못했습니다.');
          location.reload();
        } catch (error) {
          orderError.textContent = error.message;
          button.disabled = false;
        }
      });
    });
    document.querySelectorAll('button[data-move]').forEach(button => {
      button.addEventListener('click', async () => {
        const ids = ${JSON.stringify(status.accounts.map(acc => acc.id))};
        const index = ids.indexOf(button.dataset.accountId);
        const next = index + (button.dataset.move === 'up' ? -1 : 1);
        if (index < 0 || next < 0 || next >= ids.length) return;
        [ids[index], ids[next]] = [ids[next], ids[index]];
        button.disabled = true;
        try {
          const response = await fetch('/api/v1/account-chain/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: accountRevision, accountIds: ids }) });
          const result = await response.json().catch(() => null);
          if (!response.ok) throw new Error(result?.error?.message || '우선순위를 저장하지 못했습니다.');
          location.reload();
        } catch (error) {
          orderError.textContent = error.message;
          button.disabled = false;
        }
      });
    });

    const providerForm = document.querySelector('#provider-form');
    const providerError = document.querySelector('#provider-error');
    const providerType = providerForm.querySelector('[name="provider"]');
    const providerBaseUrl = providerForm.querySelector('[name="baseUrl"]');
    const providerCredential = providerForm.querySelector('[name="credential"]');
    const updateProviderFields = () => {
      const local = providerType.value === 'local-openai-compatible';
      providerCredential.required = !local;
      providerBaseUrl.placeholder = local ? 'http://127.0.0.1:11434/v1' : 'https://api.example.com/v1';
      providerBaseUrl.setAttribute('aria-label', local ? '로컬 AI URL' : 'HTTPS 제공자 URL');
      providerCredential.placeholder = local ? '선택 사항 · 로컬 API key' : 'Provider API key';
    };
    providerType.addEventListener('change', updateProviderFields);
    updateProviderFields();
    providerForm.addEventListener('submit', async event => {
      event.preventDefault();
      const submit = providerForm.querySelector('button[type="submit"]');
      const data = new FormData(providerForm);
      submit.disabled = true;
      providerError.textContent = '';
      try {
        const response = await fetch('/api/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: data.get('id'), name: data.get('name'), model: data.get('model'), baseUrl: data.get('baseUrl'), provider: data.get('provider'), credential: data.get('credential') })
        });
        const result = await response.json().catch(() => null);
        if (!response.ok) throw new Error(result?.error?.message || '계정을 등록하지 못했습니다.');
        providerForm.reset();
        location.reload();
      } catch (error) {
        providerError.textContent = error.message;
      } finally {
        submit.disabled = false;
      }
    });

    const oauthForm = document.querySelector('#oauth-form');
    const oauthError = document.querySelector('#oauth-error');
    const oauthCancel = document.querySelector('#oauth-cancel');
    const oauthCopyUrl = document.querySelector('#oauth-copy-url');
    const oauthUrlInput = document.querySelector('#oauth-url');
    let activeOAuthState = '';
    let activeOAuthUrl = '';
    let oauthGeneration = 0;
    oauthCopyUrl.addEventListener('click', async () => {
      if (!activeOAuthUrl) return;
      try {
        await navigator.clipboard.writeText(activeOAuthUrl);
        oauthError.textContent = 'The link has been copied. Go to a browser and then paste it.';
      } catch {
        oauthUrlInput.hidden = false;
        oauthUrlInput.focus();
        oauthUrlInput.select();
        oauthError.textContent = '클립보드 접근이 막혔습니다. 선택된 주소를 직접 복사해 주세요.';
      }
    });
    oauthCancel.addEventListener('click', async () => {
      if (!activeOAuthState) return;
      const state = activeOAuthState;
      ++oauthGeneration;
      oauthCancel.disabled = true;
      oauthError.textContent = '진행 중인 로그인을 취소하고 있습니다…';
      try {
        const response = await fetch('/api/oauth/chatgpt/cancel', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state })
        });
        const result = await response.json().catch(() => null);
        if (!response.ok) throw new Error(result?.error?.message || '로그인을 취소하지 못했습니다. 다시 눌러 주세요.');
        activeOAuthState = '';
        activeOAuthUrl = '';
        oauthCancel.hidden = true;
        oauthCopyUrl.hidden = true;
        oauthUrlInput.hidden = true;
        oauthCancel.disabled = false;
        oauthForm.querySelector('button[type="submit"]').disabled = false;
        oauthForm.querySelectorAll('input').forEach(input => { input.disabled = false; });
        oauthError.textContent = '로그인을 취소했습니다. 계정 ID나 표시 이름을 수정한 뒤 새 링크를 발급할 수 있습니다.';
      } catch (error) {
        oauthError.textContent = error.message;
        oauthCancel.disabled = false;
      }
    });
    oauthForm.addEventListener('submit', async event => {
      event.preventDefault();
      const submit = oauthForm.querySelector('button[type="submit"]');
      const data = new FormData(oauthForm);
      const generation = ++oauthGeneration;
      submit.disabled = true;
      oauthForm.querySelectorAll('input').forEach(input => { input.disabled = true; });
      oauthError.textContent = '3F 브라우저에서 로그인한 뒤 이 화면으로 돌아오세요.';
      try {
        const response = await fetch('/api/oauth/chatgpt/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: data.get('id'), name: data.get('name') })
        });
        const result = await response.json().catch(() => null);
        if (!response.ok) throw new Error(result?.error?.message || 'ChatGPT 로그인을 시작하지 못했습니다.');
        activeOAuthState = result.state;
        activeOAuthUrl = typeof result.authorizationUrl === 'string' ? result.authorizationUrl : '';
        oauthCancel.hidden = false;
        oauthCopyUrl.hidden = !activeOAuthUrl;
        oauthUrlInput.value = activeOAuthUrl;
        oauthUrlInput.hidden = true;
        oauthError.textContent = result.opened === false
          ? (result.openError || '로그인 창을 열지 못했습니다.') + ' 아래 URL 복사를 눌러 기본 브라우저에서 계속하세요.'
          : '기본 브라우저 창이 보이지 않으면 아래 URL 복사를 눌러 직접 여세요.';
        const deadline = Date.now() + 10 * 60 * 1000;
        while (Date.now() < deadline && generation === oauthGeneration) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (generation !== oauthGeneration) return;
          const statusResponse = await fetch('/api/oauth/chatgpt/status?state=' + encodeURIComponent(result.state), { cache: 'no-store' });
          const status = await statusResponse.json().catch(() => null);
          if (status?.pending) continue;
          if (!status?.ok) throw new Error(status?.message || 'ChatGPT 계정 연결을 완료하지 못했습니다.');
          location.reload();
          return;
        }
        if (generation === oauthGeneration && activeOAuthState) {
          await fetch('/api/oauth/chatgpt/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: activeOAuthState }) }).catch(() => {});
          activeOAuthState = '';
          activeOAuthUrl = '';
          oauthCancel.hidden = true;
          oauthCopyUrl.hidden = true;
          oauthUrlInput.hidden = true;
          throw new Error('로그인 대기 시간이 끝났습니다. 다시 링크를 발급해 주세요.');
        }
      } catch (error) {
        if (activeOAuthState && generation === oauthGeneration) {
          await fetch('/api/oauth/chatgpt/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: activeOAuthState }) }).catch(() => {});
          activeOAuthState = '';
          activeOAuthUrl = '';
          oauthCancel.hidden = true;
          oauthCopyUrl.hidden = true;
          oauthUrlInput.hidden = true;
        }
        oauthError.textContent = error.message;
        submit.disabled = false;
        oauthForm.querySelectorAll('input').forEach(input => { input.disabled = false; });
      }
    });

    document.querySelectorAll('select[data-model-account]').forEach(select => {
      select.addEventListener('change', async () => {
        select.disabled = true;
        try {
          const response = await fetch('/api/accounts/' + encodeURIComponent(select.dataset.modelAccount) + '/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: select.value }) });
          const result = await response.json().catch(() => null);
          if (!response.ok) throw new Error(result?.error?.message || '모델 선택을 저장하지 못했습니다.');
          orderError.textContent = '계정 모델을 저장했습니다.';
        } catch (error) { orderError.textContent = error.message; }
        finally { select.disabled = false; }
      });
    });

    document.querySelectorAll('button[data-refresh-models]').forEach(button => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const response = await fetch('/api/accounts/' + encodeURIComponent(button.dataset.refreshModels) + '/models', { cache: 'no-store' });
          const result = await response.json().catch(() => null);
          if (!response.ok) {
            if (result?.error?.code === 'missing_credential') {
              const status = button.closest('[data-account-row]')?.querySelector('.reconnect-status');
              if (status) status.textContent = '로그인 정보가 없습니다. ChatGPT 다시 로그인을 눌러 이 계정을 연결해 주세요.';
            }
            throw new Error(result?.error?.message || '모델 목록을 가져오지 못했습니다.');
          }
          location.reload();
        } catch (error) { orderError.textContent = error.message; button.disabled = false; }
      });
    });

    document.querySelectorAll('button[data-reconnect-chatgpt]').forEach(button => {
      button.addEventListener('click', async () => {
        const row = button.closest('[data-account-row]');
        const status = row?.querySelector('.reconnect-status');
        button.disabled = true;
        if (status) status.textContent = '기존 계정으로 ChatGPT 로그인을 다시 시작합니다…';
        try {
          const response = await fetch('/api/accounts/' + encodeURIComponent(button.dataset.reconnectChatgpt) + '/reconnect', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
          });
          const result = await response.json().catch(() => null);
          if (!response.ok) throw new Error(result?.error?.message || 'ChatGPT 로그인을 시작하지 못했습니다. 다시 시도해 주세요.');
          const deadline = Date.now() + 5 * 60 * 1000;
          while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const statusResponse = await fetch('/api/oauth/chatgpt/status?state=' + encodeURIComponent(result.state), { cache: 'no-store' });
            const loginStatus = await statusResponse.json().catch(() => null);
            if (loginStatus?.pending) continue;
            if (!loginStatus?.ok) throw new Error(loginStatus?.message || 'ChatGPT 로그인이 실패했습니다. 다시 로그인해 주세요.');
            if (status) status.textContent = '로그인 완료. 기존 계정과 순서를 유지했습니다.';
            location.reload();
            return;
          }
          throw new Error('로그인 대기 시간이 끝났습니다. 다시 로그인 버튼을 눌러 주세요.');
        } catch (error) {
          if (status) status.textContent = '로그인 실패: ' + error.message + ' 이 계정에서 다시 로그인할 수 있습니다.';
          button.disabled = false;
        }
      });
    });

    const antigravityMessage = document.querySelector('#antigravity-message');
    document.querySelector('#antigravity-open').addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const response = await fetch('/api/antigravity/open', { method: 'POST' });
        const result = await response.json().catch(() => null);
        if (!response.ok) throw new Error(result?.error?.message || 'Antigravity를 열지 못했습니다.');
        antigravityMessage.textContent = 'Antigravity에서 Google 로그인을 완료한 뒤 “로그인 확인 및 모델 가져오기”를 누르세요.';
      } catch (error) { antigravityMessage.textContent = error.message; }
      finally { button.disabled = false; }
    });
    document.querySelector('#antigravity-refresh').addEventListener('click', async event => {
      const button = event.currentTarget;
      const form = document.querySelector('#antigravity-form');
      const data = form ? new FormData(form) : null;
      const id = data?.get('id') || 'antigravity-google';
      const name = data?.get('name') || 'Antigravity 계정';
      button.disabled = true;
      antigravityMessage.textContent = 'Antigravity 로그인과 사용 가능한 모델을 확인하고 있습니다…';
      try {
        const response = await fetch('/api/antigravity/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, name })
        });
        const result = await response.json().catch(() => null);
        if (!response.ok) throw new Error(result?.error?.message || 'Antigravity 모델을 가져오지 못했습니다.');
        location.reload();
      } catch (error) { antigravityMessage.textContent = error.message; }
      finally { button.disabled = false; }
    });

    document.querySelectorAll('button[data-disconnect]').forEach(button => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const response = await fetch('/api/accounts/' + encodeURIComponent(button.dataset.accountId), { method: 'DELETE' });
          const result = await response.json().catch(() => null);
          if (!response.ok) throw new Error(result?.error?.message || '계정 연결을 해제하지 못했습니다.');
          location.reload();
        } catch (error) {
          orderError.textContent = error.message;
          button.disabled = false;
        }
      });
    });

    document.querySelectorAll('button[data-account-id]').forEach(button => {
      if (button.dataset.move || button.dataset.disconnect) return;
      button.addEventListener('click', async () => {
        await fetch('/api/accounts/quota', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: button.dataset.accountId, remainingPercent: Number(button.dataset.percent) })
        });
        location.reload();
      });
    });

    const sharedAccountButton = document.querySelector('#refresh-shared-accounts');
    if (sharedAccountButton) sharedAccountButton.addEventListener('click', async () => {
      const status = document.querySelector('#shared-account-status');
      sharedAccountButton.disabled = true;
      status.textContent = '공유 계정 목록을 새로 읽고 있습니다…';
      try {
        const response = await fetch('/api/shared-accounts', { cache: 'no-store' });
        const result = await response.json().catch(() => null);
        if (!response.ok) throw new Error(result?.error?.message || '공유 계정 목록을 읽지 못했습니다.');
        location.reload();
      } catch (error) {
        status.textContent = error.message;
        sharedAccountButton.disabled = false;
      }
    });
  </script>
</body>
</html>`;
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
            'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'X-Frame-Options': 'DENY',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'Permissions-Policy': 'camera=(), geolocation=(), microphone=()'
          });
          res.end(page);
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      });

      this.server.once('error', error => reject(error));
      this.server.listen(this.port, '127.0.0.1', () => {
        const port = this.server.address().port;
        this.port = port;
        console.log(`[ChainRouter] Server listening on http://127.0.0.1:${port}`);
        resolve({ port, url: `http://127.0.0.1:${port}` });
      });
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

module.exports = { OpenRouterCompatibleServer, completionURL };
