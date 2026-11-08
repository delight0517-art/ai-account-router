'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  isLocalProviderAccount,
  recordLocalObservation,
  summarizeLocalPerformance,
  classifyRequestComplexity,
  localRouteMode
} = require('./AdaptiveLocalRouting.js');

class AccountLibraryEngine {
  constructor(options = {}) {
    this.configDir = options.configDir || process.env.CHAIN_ROUTER_DATA_DIR || path.join(os.homedir(), '.chain-router');
    this.configFile = path.join(this.configDir, 'accounts.json');
    this.thresholdPercent = options.thresholdPercent ?? 10;
    this.tierHealth = new Map();
    this.switchHistory = [];
    this.lastActiveTierId = null;

    this.chain = this._load();
    this.thresholdPercent = this.chain.thresholdPercent ?? this.thresholdPercent;
    this.quotaResetHours = this.chain.quotaResetHours ?? 5;
    this._initHealthStates();
  }

  _ensureDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    }
  }

  _load() {
    this._ensureDir();
    if (fs.existsSync(this.configFile)) {
      try {
        const raw = fs.readFileSync(this.configFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.accounts)) {
          return {
            enabled: parsed.enabled !== false,
            thresholdPercent: Number.isFinite(parsed.thresholdPercent) && parsed.thresholdPercent >= 0 && parsed.thresholdPercent <= 100 ? parsed.thresholdPercent : 10,
            quotaResetHours: Number.isInteger(parsed.quotaResetHours) && parsed.quotaResetHours >= 1 && parsed.quotaResetHours <= 24 ? parsed.quotaResetHours : 5,
            accounts: parsed.accounts,
            tierHealth: parsed.tierHealth || {},
            revision: Number.isSafeInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0,
            updatedAt: parsed.updatedAt || Date.now()
          };
        }
      } catch (err) {
        console.warn('[AccountLibrary] Failed to load config, initializing default:', err.message);
      }
    }
    const defaultData = {
      enabled: true,
      thresholdPercent: 10,
      quotaResetHours: 5,
      revision: 0,
      accounts: [
        {
          tier: 1,
          id: 'acc-primary',
          name: 'Primary demo profile',
          provider: 'demo',
          model: 'placeholder',
          account: '',
          email: '',
          enabled: true
        },
        {
          tier: 2,
          id: 'acc-secondary',
          name: 'Secondary demo profile',
          provider: 'demo',
          model: 'placeholder',
          account: '',
          email: '',
          enabled: true
        }
      ],
      updatedAt: Date.now()
    };
    this._save(defaultData);
    return defaultData;
  }

  _save(data = this.chain) {
    this._ensureDir();
    const temporary = `${this.configFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ ...data, tierHealth: Object.fromEntries(this.tierHealth) }, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, this.configFile);
    } catch (err) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      throw err;
    }
  }

  _initHealthStates() {
    for (const acc of this.chain.accounts) {
      if (!this.tierHealth.has(acc.id)) {
        this.tierHealth.set(acc.id, {
          totalRemainingPercent: null,
          quotaThrottled: false,
          isThrottled: false,
          throttledReason: null,
          lastCheckedAt: null,
          ...this.chain.tierHealth?.[acc.id]
        });
      }
    }
  }

  resolveActiveAccount(overrideId = null, excludedIds = [], preferredModel = null, requestBody = null) {
    const now = Date.now();
    for (const health of this.tierHealth.values()) {
      if (health.quotaResetAt && now >= health.quotaResetAt) {
        Object.assign(health, { totalRemainingPercent: null, isThrottled: false, quotaThrottled: false, quotaResetAt: null });
      }
    }

    if (overrideId) {
      const explicit = this.chain.accounts.find(a => a.id === overrideId && a.enabled);
      const health = explicit ? this.tierHealth.get(explicit.id) : null;
      if (explicit && health && !health.isThrottled && !health.quotaThrottled) {
        this.lastActiveTierId = explicit.id;
        return explicit;
      }
    }

    const requestComplexity = classifyRequestComplexity(requestBody);
    const sorted = [...this.chain.accounts]
      .filter(a => a.enabled && !excludedIds.includes(a.id) && (!preferredModel || a.model === preferredModel
        || a.availableModels?.some(model => model.id === preferredModel)))
      .map(account => {
        const explicitlySelected = Boolean(preferredModel && (account.model === preferredModel
          || account.availableModels?.some(model => model.id === preferredModel)));
        const mode = localRouteMode(account, this.tierHealth.get(account.id), { requestComplexity, explicitlySelected });
        return { account, mode };
      })
      .filter(item => item.mode !== 'excluded')
      .sort((a, b) => Number(['fallback', 'reduced'].includes(a.mode)) - Number(['fallback', 'reduced'].includes(b.mode))
        || a.account.tier - b.account.tier)
      .map(item => item.account);

    for (const acc of sorted) {
      const health = this.tierHealth.get(acc.id) || { isThrottled: false, totalRemainingPercent: 100 };
      if (!health.isThrottled && !health.quotaThrottled && (health.totalRemainingPercent == null || health.totalRemainingPercent >= this.thresholdPercent)) {
        if (this.lastActiveTierId && this.lastActiveTierId !== acc.id) {
          const old = this.chain.accounts.find(a => a.id === this.lastActiveTierId);
          const msg = `Account failover: [${old?.name || this.lastActiveTierId}] -> [${acc.name}]`;
          console.log(`[AccountLibrary] ${msg}`);
          this.switchHistory.push({ from: this.lastActiveTierId, to: acc.id, at: now, reason: 'quota_drop_or_switch' });
        }
        this.lastActiveTierId = acc.id;
        return acc;
      }
    }

    this.lastActiveTierId = null;
    return null;
  }

  updateAccountQuota(accountId, remainingPercent) {
    if (!Number.isFinite(remainingPercent)) return;
    const health = this.tierHealth.get(accountId);
    if (!health) return;

    health.totalRemainingPercent = Math.max(0, Math.min(100, remainingPercent));
    health.lastCheckedAt = Date.now();
    if (health.totalRemainingPercent < this.thresholdPercent) {
      health.quotaThrottled = true;
      health.isThrottled = true;
      health.throttledReason = `Remaining quota ${health.totalRemainingPercent}% < threshold ${this.thresholdPercent}%`;
      if (!Number.isFinite(health.quotaResetAt) || health.quotaResetAt <= Date.now()) {
        health.quotaResetAt = Date.now() + this.quotaResetHours * 60 * 60 * 1000;
      }
    } else {
      health.quotaThrottled = false;
      health.isThrottled = false;
      health.throttledReason = null;
    }
    this._save();
  }

  setRoutingLimits({ thresholdPercent, quotaResetHours, expectedRevision }) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== (this.chain.revision ?? 0)) {
      throw Object.assign(new Error('The routing settings changed; reload before saving.'), { code: 'stale_revision' });
    }
    if (!Number.isInteger(thresholdPercent) || thresholdPercent < 0 || thresholdPercent > 100 ||
        !Number.isInteger(quotaResetHours) || quotaResetHours < 1 || quotaResetHours > 24) {
      throw Object.assign(new Error('Threshold must be 0–100% and the fallback reset time must be 1–24 hours.'), { code: 'invalid_routing_limits' });
    }
    const now = Date.now();
    const next = {
      ...this.chain,
      thresholdPercent,
      quotaResetHours,
      revision: (this.chain.revision ?? 0) + 1,
      updatedAt: now
    };
    const previousHealth = this.tierHealth;
    this.tierHealth = new Map([...previousHealth].map(([id, health]) => [id, { ...health }]));
    for (const health of this.tierHealth.values()) {
      if (!Number.isFinite(health.totalRemainingPercent)) continue;
      const belowThreshold = health.totalRemainingPercent < thresholdPercent;
      health.quotaThrottled = belowThreshold;
      health.isThrottled = belowThreshold;
      health.throttledReason = belowThreshold
        ? `Remaining quota ${health.totalRemainingPercent}% < threshold ${thresholdPercent}%`
        : null;
      if (belowThreshold && (!Number.isFinite(health.quotaResetAt) || health.quotaResetAt <= now)) {
        health.quotaResetAt = now + quotaResetHours * 60 * 60 * 1000;
      }
    }
    try {
      this._save(next);
    } catch (error) {
      this.tierHealth = previousHealth;
      throw error;
    }
    this.chain = next;
    this.thresholdPercent = thresholdPercent;
    this.quotaResetHours = quotaResetHours;
    return { revision: next.revision, updatedAt: next.updatedAt };
  }

  recordLocalPerformance(accountId, ok, latencyMs, now = Date.now()) {
    const account = this.chain.accounts.find(item => item.id === accountId);
    if (!isLocalProviderAccount(account)) return null;
    const health = this.tierHealth.get(accountId);
    if (!health) return null;
    health.localPerformance = recordLocalObservation(health.localPerformance, ok, latencyMs, now);
    this._save();
    return summarizeLocalPerformance(health.localPerformance, now);
  }

  upsertAccount(data) {
    const demoAccounts = data.provider === 'demo'
      ? []
      : this.chain.accounts.filter(account => account.provider === 'demo');
    const accounts = this.chain.accounts
      .filter(account => account.provider !== 'demo' || data.provider === 'demo')
      .map((account, position) => demoAccounts.length ? { ...account, tier: position + 1 } : account);
    const idx = accounts.findIndex(a => a.id === data.id);
    if (idx >= 0) {
      const previous = accounts[idx];
      accounts[idx] = { ...previous, ...data };
      if (previous.provider !== accounts[idx].provider || previous.baseUrl !== accounts[idx].baseUrl
        || previous.model !== accounts[idx].model) {
        const health = this.tierHealth.get(data.id);
        if (health) delete health.localPerformance;
      }
    } else {
      const nextTier = accounts.length + 1;
      accounts.push({
        ...data,
        tier: data.tier || nextTier,
        id: data.id || `acc-${Date.now()}`,
        name: data.name || `${nextTier}순위 계정`,
        provider: data.provider || 'custom',
        model: data.model || 'gpt-4o',
        account: data.account || '',
        email: data.email || '',
        enabled: data.enabled !== false
      });
    }
    const next = {
      ...this.chain,
      accounts,
      revision: (this.chain.revision ?? 0) + 1,
      updatedAt: Date.now()
    };
    this._save(next);
    this.chain = next;
    for (const account of demoAccounts) {
      this.tierHealth.delete(account.id);
      if (this.lastActiveTierId === account.id) this.lastActiveTierId = null;
    }
    this._initHealthStates();
    return true;
  }

  removeAccount(accountId) {
    const index = this.chain.accounts.findIndex(account => account.id === accountId);
    if (index < 0) return false;
    const nextAccounts = this.chain.accounts
      .filter(account => account.id !== accountId)
      .map((account, position) => ({ ...account, tier: position + 1 }));
    this.chain = {
      ...this.chain,
      accounts: nextAccounts,
      revision: (this.chain.revision ?? 0) + 1,
      updatedAt: Date.now()
    };
    this.tierHealth.delete(accountId);
    if (this.lastActiveTierId === accountId) this.lastActiveTierId = null;
    this._save();
    return true;
  }

  setAccountRank(accountId, rank) {
    const idx = this.chain.accounts.findIndex(a => a.id === accountId);
    if (idx < 0 || !Number.isSafeInteger(rank) || rank < 1 || rank > this.chain.accounts.length) return false;
    const ids = this.chain.accounts.map(a => a.id);
    const [target] = ids.splice(idx, 1);
    ids.splice(rank - 1, 0, target);
    this.reorderAccounts(ids, this.chain.revision ?? 0);
    return true;
  }

  reorderAccounts(accountIds, expectedRevision) {
    const currentRevision = this.chain.revision ?? 0;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== currentRevision) {
      const error = new Error('The account order changed; reload it before saving.');
      error.code = 'stale_revision';
      throw error;
    }
    const existing = this.chain.accounts.map(account => account.id);
    if (!Array.isArray(accountIds) || accountIds.length !== existing.length ||
        accountIds.some(id => typeof id !== 'string' || id.length === 0) ||
        new Set(accountIds).size !== existing.length ||
        accountIds.some(id => !existing.includes(id))) {
      const error = new Error('The submitted IDs must be an exact permutation of the current accounts.');
      error.code = 'invalid_order';
      throw error;
    }
    const byId = new Map(this.chain.accounts.map(account => [account.id, account]));
    const next = {
      ...this.chain,
      accounts: accountIds.map((id, index) => ({ ...byId.get(id), tier: index + 1 })),
      revision: currentRevision + 1,
      updatedAt: Date.now()
    };
    this._save(next);
    this.chain = next;
    return { revision: next.revision, updatedAt: next.updatedAt };
  }

  getStatus() {
    return {
      enabled: this.chain.enabled,
      revision: this.chain.revision ?? 0,
      thresholdPercent: this.thresholdPercent,
      quotaResetHours: this.quotaResetHours,
      activeAccount: this.resolveActiveAccount(),
      accounts: this.chain.accounts.map(acc => ({
        ...acc,
        health: this.tierHealth.get(acc.id),
        ...(isLocalProviderAccount(acc) ? { localAi: summarizeLocalPerformance(this.tierHealth.get(acc.id)?.localPerformance) } : {})
      })),
      history: this.switchHistory.slice(-10)
    };
  }
}

module.exports = { AccountLibraryEngine };
