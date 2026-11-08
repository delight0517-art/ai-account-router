'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function keychainRequest(action, service, account, value, options = {}) {
  const run = options.spawnSync || spawnSync;
  const helper = options.helperPath || process.env.AI_ACCOUNT_ROUTER_KEYCHAIN_HELPER
    || path.resolve(__dirname, '../bin/RouterCredentialBridge');
  const result = run(helper, [], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
    input: JSON.stringify({ action, service, account, ...(value !== undefined ? { value } : {}),
      ...(options.keychain ? { keychainPath: options.keychain } : {}) })
  });
  let response;
  try { response = JSON.parse(result.stdout); } catch {}
  if (result.error || result.status !== 0 || response?.ok !== true) {
    const status = Number.isInteger(response?.status) ? ` (OSStatus ${response.status})` : '';
    throw Object.assign(new Error(`macOS Keychain ${action} failed${status}.`), { code: 'keychain_unavailable' });
  }
  return response;
}
function readGenericPassword(service, account, options = {}) {
  return keychainRequest('get', service, account, undefined, options).value ?? null;
}
function writeGenericPassword(service, account, value, options = {}) {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 262144) throw new Error('Invalid Keychain input.');
  keychainRequest('set', service, account, value, options);
  if (readGenericPassword(service, account, options) !== value) throw new Error('Credential could not be saved and verified in macOS Keychain.');
}
function deleteGenericPassword(service, account, options = {}) {
  keychainRequest('delete', service, account, undefined, options);
}
module.exports = { readGenericPassword, writeGenericPassword, deleteGenericPassword };
