'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIRECTORY_NAME = 'AI Account Router Shared Accounts';
const EVENTS_DIRECTORY = 'events';
const MAX_EVENTS = 10000;
const MAX_EVENT_BYTES = 8192;
const PROVIDER_NAMES = Object.freeze({
  'chatgpt-plan': 'ChatGPT',
  'antigravity-cli': 'Google Antigravity'
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}

function profileIdentity(account) {
  const provider = PROVIDER_NAMES[account?.provider] ? account.provider : null;
  const email = validEmail(account?.email) ? account.email.trim() : '';
  if (!provider || !email) return null;
  const normalizedEmail = email.toLowerCase();
  const profileKey = crypto.createHash('sha256')
    .update(`${provider}\0${normalizedEmail}`)
    .digest('hex');
  return { profileKey, provider, email };
}

function deviceKind(platform) {
  if (platform === 'darwin') return 'Mac';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return 'Unknown device';
}

function findMyDriveRoots({ platform = process.platform, homedir = os.homedir(), env = process.env, fsImpl = fs } = {}) {
  const roots = new Set();
  const addIfDrive = candidate => {
    if (typeof candidate !== 'string' || !candidate) return;
    const resolved = path.resolve(candidate);
    if (fsImpl.existsSync(path.join(resolved, 'My Drive'))) roots.add(path.join(resolved, 'My Drive'));
    else if (path.basename(resolved).toLowerCase() === 'my drive' && fsImpl.existsSync(resolved)) roots.add(resolved);
  };

  if (env.CHAIN_ROUTER_SHARED_ACCOUNTS_DIR) {
    const directory = path.resolve(env.CHAIN_ROUTER_SHARED_ACCOUNTS_DIR);
    if (/gpt-shared-work/i.test(directory)) return [];
    if (fsImpl.existsSync(directory) || fsImpl.existsSync(path.dirname(directory))) return [directory];
  }

  if (platform === 'darwin') {
    const cloudStorage = path.join(homedir, 'Library', 'CloudStorage');
    try {
      const entries = fsImpl.readdirSync(cloudStorage).filter(entry => /^GoogleDrive-/i.test(entry));
      const canonical = entries.filter(entry => !/\s\([^)]*\)$/i.test(entry));
      for (const entry of canonical.length === 1 ? canonical : entries) {
        addIfDrive(path.join(cloudStorage, entry));
      }
    } catch {}
  } else if (platform === 'win32') {
    addIfDrive(homedir);
    addIfDrive(path.join(homedir, 'Google Drive'));
    for (let letter = 65; letter <= 90; letter += 1) {
      addIfDrive(`${String.fromCharCode(letter)}:\\`);
    }
  }

  return [...roots];
}

function resolveSharedDirectory(options = {}) {
  const roots = findMyDriveRoots(options);
  if (roots.length !== 1) return null;
  return path.join(roots[0], DIRECTORY_NAME);
}

function validEvent(event) {
  const allowedKeys = ['schemaVersion', 'action', 'eventId', 'deviceId', 'profileKey', 'provider', 'email', 'device', 'linkedAt'];
  return Boolean(event && typeof event === 'object' && !Array.isArray(event) &&
    Object.keys(event).every(key => allowedKeys.includes(key)) &&
    event.schemaVersion === 1 && UUID_PATTERN.test(event.eventId || '') &&
    UUID_PATTERN.test(event.deviceId || '') &&
    typeof event.profileKey === 'string' && /^[0-9a-f]{64}$/.test(event.profileKey) &&
    Object.hasOwn(PROVIDER_NAMES, event.provider) && validEmail(event.email) &&
    typeof event.device === 'string' && ['Mac', 'Windows', 'Linux', 'Unknown device'].includes(event.device) &&
    (event.action === undefined || ['linked', 'unlinked'].includes(event.action)) &&
    typeof event.linkedAt === 'string' && Number.isFinite(Date.parse(event.linkedAt)));
}

class SharedAccountCatalog {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    this.path = options.path || path;
    this.configDir = options.configDir || process.env.CHAIN_ROUTER_DATA_DIR || this.path.join(os.homedir(), '.chain-router');
    const explicitSharedDirectory = options.sharedDirectory && !/gpt-shared-work/i.test(options.sharedDirectory)
      ? options.sharedDirectory
      : null;
    this.sharedDirectory = explicitSharedDirectory || resolveSharedDirectory({
      platform: options.platform,
      homedir: options.homedir,
      env: options.env,
      fsImpl: this.fs
    });
    this.platform = options.platform || process.platform;
    this.idFactory = options.idFactory || (() => crypto.randomUUID());
    this.clock = options.clock || (() => new Date());
    this.deviceIdFile = this.path.join(this.configDir, 'shared-account-device-id');
  }

  _deviceId() {
    this.fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    try {
      const existing = this.fs.readFileSync(this.deviceIdFile, 'utf8').trim();
      if (UUID_PATTERN.test(existing)) return existing;
    } catch {}
    const id = this.idFactory();
    if (!UUID_PATTERN.test(id)) throw new Error('The local device identifier is invalid.');
    const temporary = `${this.deviceIdFile}.${id}.tmp`;
    this.fs.writeFileSync(temporary, `${id}\n`, { mode: 0o600, flag: 'wx' });
    this.fs.renameSync(temporary, this.deviceIdFile);
    return id;
  }

  _readEvents() {
    if (!this.sharedDirectory) return [];
    const directory = this.path.join(this.sharedDirectory, EVENTS_DIRECTORY);
    if (!this.fs.existsSync(directory)) return [];
    const names = this.fs.readdirSync(directory)
      .filter(name => /^[0-9a-f-]{36}\.json$/i.test(name))
      .sort()
      .slice(-MAX_EVENTS);
    const events = [];
    for (const name of names) {
      const file = this.path.join(directory, name);
      try {
        const info = this.fs.lstatSync(file);
        if (!info.isFile() || info.size < 1 || info.size > MAX_EVENT_BYTES) continue;
        const event = JSON.parse(this.fs.readFileSync(file, 'utf8'));
        if (validEvent(event)) events.push(event);
      } catch {}
    }
    return events;
  }

  _writeEvent(identity, deviceId, action) {
    const eventsDirectory = this.path.join(this.sharedDirectory, EVENTS_DIRECTORY);
    this.fs.mkdirSync(eventsDirectory, { recursive: true, mode: 0o700 });
    const eventId = this.idFactory();
    if (!UUID_PATTERN.test(eventId)) throw new Error('The shared event identifier is invalid.');
    const event = {
      schemaVersion: 1,
      action,
      eventId,
      deviceId,
      profileKey: identity.profileKey,
      provider: identity.provider,
      email: identity.email,
      device: deviceKind(this.platform),
      linkedAt: this.clock().toISOString()
    };
    const target = this.path.join(eventsDirectory, `${eventId}.json`);
    const temporary = this.path.join(eventsDirectory, `.${eventId}.tmp`);
    try {
      this.fs.writeFileSync(temporary, `${JSON.stringify(event)}\n`, { mode: 0o600, flag: 'wx' });
      this.fs.renameSync(temporary, target);
    } finally {
      try { this.fs.unlinkSync(temporary); } catch {}
    }
    return event;
  }

  sync(accounts = []) {
    if (!this.sharedDirectory) {
      return { state: 'unavailable', provider: 'Google Drive', profiles: [], linkedHere: 0, reason: 'Google Drive My Drive is not mounted or more than one Drive account is mounted.' };
    }
    if (!this.fs.existsSync(this.sharedDirectory)) {
      return { state: 'pending', provider: 'Google Drive', profiles: [], linkedHere: 0, reason: 'The private shared folder has not synced into this device’s Google Drive Desktop mount yet.' };
    }
    try {
      const deviceId = this._deviceId();
      const existing = this._readEvents();
      const identities = (Array.isArray(accounts) ? accounts : []).map(profileIdentity).filter(Boolean);
      const localIdentities = new Map(identities.map(identity => [identity.profileKey, identity]));
      const latestByDeviceProfile = new Map();
      const updateLatest = event => {
        const key = event.deviceId + ':' + event.profileKey;
        const previous = latestByDeviceProfile.get(key);
        const eventTime = Date.parse(event.linkedAt);
        if (!previous || eventTime > Date.parse(previous.linkedAt) ||
          (eventTime === Date.parse(previous.linkedAt) && event.eventId > previous.eventId)) {
          latestByDeviceProfile.set(key, event);
        }
      };
      for (const event of existing) updateLatest(event);
      let published = 0;
      for (const identity of identities) {
        const latest = latestByDeviceProfile.get(deviceId + ':' + identity.profileKey);
        if (!latest || latest.action === 'unlinked') {
          const event = this._writeEvent(identity, deviceId, 'linked');
          existing.push(event);
          updateLatest(event);
          published += 1;
        }
      }
      for (const [key, latest] of latestByDeviceProfile) {
        if (latest.deviceId !== deviceId || latest.action === 'unlinked' || localIdentities.has(latest.profileKey)) continue;
        const event = this._writeEvent(latest, deviceId, 'unlinked');
        existing.push(event);
        updateLatest(event);
        published += 1;
      }

      const byProfile = new Map();
      for (const event of latestByDeviceProfile.values()) {
        if (event.action === 'unlinked') continue;
        let profile = byProfile.get(event.profileKey);
        if (!profile) {
          profile = { profileKey: event.profileKey, provider: event.provider, providerName: PROVIDER_NAMES[event.provider], email: event.email, devices: new Map(), lastLinkedAt: event.linkedAt };
          byProfile.set(event.profileKey, profile);
        }
        profile.devices.set(event.deviceId, { name: event.device, linkedAt: event.linkedAt });
        if (Date.parse(profile.lastLinkedAt) < Date.parse(event.linkedAt)) profile.lastLinkedAt = event.linkedAt;
      }

      const localKeys = new Set(identities.map(identity => identity.profileKey));
      const profiles = [...byProfile.values()].map(profile => ({
        profileKey: profile.profileKey,
        provider: profile.provider,
        providerName: profile.providerName,
        email: profile.email,
        devices: [...profile.devices.values()].sort((a, b) => a.name.localeCompare(b.name)),
        connectedHere: localKeys.has(profile.profileKey),
        lastLinkedAt: profile.lastLinkedAt
      })).sort((a, b) => a.providerName.localeCompare(b.providerName) || a.email.localeCompare(b.email));
      return { state: 'available', provider: 'Google Drive', currentDevice: deviceKind(this.platform), profiles, linkedHere: localKeys.size, published };
    } catch {
      return { state: 'error', provider: 'Google Drive', profiles: [], linkedHere: 0, reason: 'The shared account list could not be read or updated.' };
    }
  }
}

module.exports = {
  DIRECTORY_NAME,
  EVENTS_DIRECTORY,
  PROVIDER_NAMES,
  SharedAccountCatalog,
  deviceKind,
  findMyDriveRoots,
  profileIdentity,
  resolveSharedDirectory,
  validEvent
};
