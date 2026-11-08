'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openLoginBrowser } = require('./login-browser.js');
const { readGenericPassword, writeGenericPassword, deleteGenericPassword } = require('./keychain.js');

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const REQUIRED_SCOPE = 'chatgpt.tokens.use.direct';
const KEYCHAIN_SERVICE = 'com.rogan.priority-chain-router.chatgpt-session';

const randomToken = bytes => crypto.randomBytes(bytes).toString('base64url');

function readKeychainSession(accountId) {
  const stored = readGenericPassword(KEYCHAIN_SERVICE, String(accountId));
  if (!stored) return null;
  try {
    return JSON.parse(/^(?:[a-f0-9]{2})+$/i.test(stored) ? Buffer.from(stored, 'hex').toString('utf8') : stored);
  }
  catch { return null; }
}

function writeKeychainSession(accountId, session) {
  writeGenericPassword(KEYCHAIN_SERVICE, String(accountId), JSON.stringify(session));
}

function deleteKeychainSession(accountId) {
  deleteGenericPassword(KEYCHAIN_SERVICE, String(accountId));
}

function openChatGptLogin(url, options = {}) {
  return openLoginBrowser(url, options);
}

function decodeJsonPart(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function isMatchingRedirect(flowRedirectUri, callbackUrl) {
  try {
    const flow = new URL(flowRedirectUri);
    if (flow.pathname !== callbackUrl.pathname) return false;
    const isLoopback = h => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(h);
    const flowPort = flow.port || (flow.protocol === 'https:' ? '443' : '80');
    const cbPort = callbackUrl.port || (callbackUrl.protocol === 'https:' ? '443' : '80');
    if (flowPort !== cbPort) return false;
    if (flow.hostname === callbackUrl.hostname) return true;
    if (isLoopback(flow.hostname) && isLoopback(callbackUrl.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

class ChatGptOAuthManager {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch;
    this.openExternal = options.openExternal || openChatGptLogin;
    this.readSession = options.readSession || readKeychainSession;
    this.writeSession = options.writeSession || writeKeychainSession;
    this.deleteSession = options.deleteSession || deleteKeychainSession;
    this.clock = options.clock || (() => Date.now());
    this.configDir = options.configDir || process.env.CHAIN_ROUTER_DATA_DIR || path.join(os.homedir(), '.chain-router');
    this.flows = new Map();
    this.results = new Map();
    this.refreshes = new Map();
    this.hostId = `urn:uuid:${this._stableHostId()}`;
  }

  _stableHostId() {
    const file = path.join(this.configDir, 'chatgpt-oauth-host-id');
    try {
      const current = fs.readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f-]{36}$/i.test(current)) return current;
    } catch {}
    const value = crypto.randomUUID();
    fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${value}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return value;
  }

  async _listModelsForToken(accessToken) {
    const response = await this.fetch(`${RESOURCE}/models`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw Object.assign(new Error(`ChatGPT model list failed with HTTP ${response.status}.`), { code: 'model_list_failed' });
    const document = await response.json();
    const entries = Array.isArray(document.models) ? document.models : Array.isArray(document.data) ? document.data : [];
    const models = entries
      .filter(item => item && (item.visibility === undefined || item.visibility === 'list'))
      .map(item => ({ id: String(item.slug || item.id || ''), name: String(item.display_name || item.name || item.slug || item.id || '') }))
      .filter(item => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(item.id))
      .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
    if (!models.length) throw Object.assign(new Error('No ChatGPT models are available to this account.'), { code: 'no_models_available' });
    return models;
  }

  async listModels(accountId) {
    return this._listModelsForToken(await this.accessToken(accountId));
  }

  async _discovery() {
    const response = await this.fetch(`${ISSUER}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`OpenID discovery failed with HTTP ${response.status}.`);
    const document = await response.json();
    if (document.issuer !== ISSUER) throw new Error('OpenID issuer mismatch.');
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      const endpoint = new URL(document[key]);
      if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'auth.openai.com') {
        throw new Error(`Invalid OpenID ${key}.`);
      }
    }
    if (document.revocation_endpoint) {
      const endpoint = new URL(document.revocation_endpoint);
      if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'auth.openai.com') {
        throw new Error('Invalid OpenID revocation_endpoint.');
      }
    }
    return document;
  }

  _cleanup() {
    const cutoff = this.clock() - 10 * 60 * 1000;
    for (const [state, flow] of this.flows) if (!flow.completing && flow.createdAt < cutoff) this.flows.delete(state);
    for (const [state, result] of this.results) if (result.createdAt < cutoff) this.results.delete(state);
  }

  async start({ accountId, name, model, redirectUri, reconnect = false }) {
    this._cleanup();
    const discovery = await this._discovery();
    // A page reload can lose the browser's in-memory OAuth state. Starting again
    // for the same account ID must supersede that stale link so the user can retry.
    for (const [pendingState, pendingFlow] of this.flows) {
      if (pendingFlow.accountId === accountId) {
        if (pendingFlow.completing) throw Object.assign(new Error('ChatGPT sign-in is still being completed.'), { code: 'oauth_in_progress' });
        this.cancel(pendingState);
      }
    }
    const state = randomToken(32);
    const nonce = randomToken(32);
    const verifier = randomToken(64);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const flow = {
      accountId,
      name,
      model,
      reconnect: reconnect === true,
      state,
      nonce,
      verifier,
      redirectUri,
      createdAt: this.clock(),
      discovery
    };
    this.flows.set(state, flow);
    const authorization = new URL(discovery.authorization_endpoint);
    authorization.search = new URLSearchParams({
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'AI Account Router',
      ext_agent_host_id: this.hostId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: `openid profile email offline_access resource.invoke ${REQUIRED_SCOPE}`,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account'
    }).toString();
    let opened = true;
    let openError = '';
    try {
      opened = (await this.openExternal(authorization.toString())) !== false;
      if (!opened) openError = '기본 브라우저가 로그인 창 열기를 확인하지 못했습니다.';
    } catch (error) {
      // Keep the short-lived PKCE flow alive so the user can paste the same URL
      // into a browser when the app could not open a window.
      opened = false;
      openError = error?.message || '로그인 창을 열지 못했습니다.';
    }
    return { state, authorizationUrl: authorization.toString(), opened, openError };
  }

  async _verifyIdToken(token, clientId, nonce, discovery) {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new Error('Invalid ID token.');
    const header = decodeJsonPart(parts[0]);
    const claims = decodeJsonPart(parts[1]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Invalid ID token signature header.');
    const jwksResponse = await this.fetch(discovery.jwks_uri, { signal: AbortSignal.timeout(20000) });
    if (!jwksResponse.ok) throw new Error('OpenID signing keys could not be loaded.');
    const jwks = await jwksResponse.json();
    const jwk = Array.isArray(jwks.keys) && jwks.keys.find(key =>
      key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
    if (!jwk) throw new Error('ID token signing key is missing.');
    const verified = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      crypto.createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url')
    );
    const audiences = typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
    const now = Math.floor(this.clock() / 1000);
    if (!verified || claims.iss !== ISSUER || !audiences.includes(clientId) ||
        (claims.azp && claims.azp !== clientId) || !Number.isFinite(claims.exp) || claims.exp <= now ||
        (Number.isFinite(claims.nbf) && claims.nbf > now) || claims.nonce !== nonce ||
        typeof claims.sub !== 'string' || !claims.sub) {
      throw new Error('ID token claim validation failed.');
    }
    return { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : '' };
  }

  async complete(callbackUrl) {
    this._cleanup();
    const state = callbackUrl.searchParams.get('state') || '';
    const flow = this.flows.get(state);
    if (!flow || !isMatchingRedirect(flow.redirectUri, callbackUrl)) throw new Error('The sign-in request expired or its state did not match.');
    if (flow.completing) throw new Error('The sign-in callback is already being processed.');
    flow.completing = true;
    try {
      if (callbackUrl.searchParams.get('error')) throw new Error('ChatGPT sign-in was cancelled or declined.');
      const code = callbackUrl.searchParams.get('code');
      const clientId = callbackUrl.searchParams.get('client_id');
      if (!code || !clientId || clientId === 'dynamic_agent_client') throw new Error('ChatGPT app registration response was incomplete.');
      const tokenResponse = await this.fetch(flow.discovery.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: flow.verifier,
          redirect_uri: flow.redirectUri,
          resource: RESOURCE
        }),
        signal: AbortSignal.timeout(20000)
      });
      if (!tokenResponse.ok) throw new Error(`ChatGPT token exchange failed with HTTP ${tokenResponse.status}.`);
      const tokens = await tokenResponse.json();
      if (typeof tokens.id_token !== 'string' || typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string') {
        throw new Error('ChatGPT token response was incomplete.');
      }
      const identity = await this._verifyIdToken(tokens.id_token, clientId, flow.nonce, flow.discovery);
      const scopes = String(tokens.scope || '').split(/\s+/).filter(Boolean);
      if (!scopes.includes(REQUIRED_SCOPE)) throw new Error('ChatGPT plan access scope was not granted.');
      const models = await this._listModelsForToken(tokens.access_token);
      const selectedModel = flow.model ? models.find(model => model.id === flow.model) : models[0];
      if (!selectedModel) throw new Error('The selected ChatGPT model is not available to this account.');
      const session = {
        clientId,
        subject: identity.subject,
        email: identity.email,
        idToken: tokens.id_token,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: this.clock() + (Number(tokens.expires_in) || 3600) * 1000,
        scopes
      };
      this.writeSession(flow.accountId, session);
      const result = {
        ok: true,
        createdAt: this.clock(),
        state,
        profile: {
          id: flow.accountId,
          name: flow.name,
          email: identity.email,
          account: identity.email,
          provider: 'chatgpt-plan',
          model: selectedModel.id,
          availableModels: models,
          baseUrl: `${RESOURCE}/responses`,
          credentialRef: flow.accountId,
          enabled: true
        }
      };
      this.results.set(state, result);
      return result;
    } catch (error) {
      this.results.set(state, { ok: false, createdAt: this.clock(), state, message: error.message });
      throw error;
    } finally {
      this.flows.delete(state);
    }
  }

  status(state) {
    this._cleanup();
    if (this.results.has(state)) return this.results.get(state);
    if (this.flows.has(state)) return { ok: true, pending: true };
    return { ok: false, expired: true, message: 'The sign-in request expired.' };
  }

  cancel(state) {
    this._cleanup();
    const flow = this.flows.get(state);
    if (!flow) return { ok: false, expired: true, message: 'The sign-in request is no longer pending.' };
    if (flow.completing) return { ok: false, pending: true, message: 'The sign-in callback is still being processed.' };
    this.flows.delete(state);
    const result = { ok: false, canceled: true, state, createdAt: this.clock(), message: '로그인을 취소했습니다. 새 링크를 발급할 수 있습니다.' };
    this.results.set(state, result);
    return result;
  }

  fail(state, message) {
    this.results.set(state, { ok: false, createdAt: this.clock(), state, message });
  }

  async accessToken(accountId) {
    const session = this.readSession(accountId);
    if (!session || !session.scopes?.includes(REQUIRED_SCOPE)) throw Object.assign(new Error('ChatGPT sign-in is required.'), { code: 'missing_credential' });
    if (session.expiresAt > this.clock() + 2 * 60 * 1000) return session.accessToken;
    if (this.refreshes.has(accountId)) return this.refreshes.get(accountId);
    const refresh = this._refresh(accountId, session).finally(() => this.refreshes.delete(accountId));
    this.refreshes.set(accountId, refresh);
    return refresh;
  }

  async _refresh(accountId, session) {
    const discovery = await this._discovery();
    const response = await this.fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: session.clientId,
        refresh_token: session.refreshToken,
        resource: RESOURCE
      }),
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw Object.assign(new Error(`ChatGPT token refresh failed with HTTP ${response.status}.`), { code: 'provider_auth_failed' });
    const body = await response.json();
    if (typeof body.access_token !== 'string') throw new Error('ChatGPT refresh response was incomplete.');
    const updated = {
      ...session,
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : session.refreshToken,
      expiresAt: this.clock() + (Number(body.expires_in) || 3600) * 1000,
      scopes: String(body.scope || session.scopes.join(' ')).split(/\s+/).filter(Boolean)
    };
    this.writeSession(accountId, updated);
    return updated.accessToken;
  }

  async disconnect(accountId) {
    const session = this.readSession(accountId);
    try {
      if (session?.refreshToken) {
        const discovery = await this._discovery();
        if (discovery.revocation_endpoint) {
          await this.fetch(discovery.revocation_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              token: session.refreshToken,
              token_type_hint: 'refresh_token',
              client_id: session.clientId
            }),
            signal: AbortSignal.timeout(20000)
          });
        }
      }
    } catch {}
    this.deleteSession(accountId);
  }
}

module.exports = { ChatGptOAuthManager, ISSUER, RESOURCE, REQUIRED_SCOPE, openChatGptLogin };
