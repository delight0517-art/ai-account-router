'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const DEFAULT_CLI = process.env.ANTIGRAVITY_CLI_PATH || path.join(os.homedir(), '.local/bin/agy');

function oauthOnlyEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GCLOUD_PROJECT|GOOGLE_CLOUD_PROJECT|GOOGLE_CLOUD_QUOTA_PROJECT|CLOUDSDK_CONFIG)$/i.test(key)) delete env[key];
  }
  return env;
}

class AntigravityCli {
  constructor(options = {}) {
    this.cliPath = options.cliPath || DEFAULT_CLI;
    this.execFileSync = options.execFileSync || spawnSync;
    this.spawn = options.spawn || spawn;
    this.tempDir = options.tempDir || os.tmpdir();
  }

  listModels() {
    const result = this.execFileSync(this.cliPath, ['models'], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
      env: oauthOnlyEnvironment()
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Object.assign(new Error('Antigravity is not signed in. Open Antigravity and sign in with Google, then refresh.'), { code: 'antigravity_auth_required' });
    const models = String(result.stdout || '').split(/\r?\n/).map(line => {
      const match = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]{0,119})(?:\t+| {2,})(\S.*)$/);
      return match ? { id: match[1], name: match[2].trim() } : null;
    }).filter(Boolean);
    if (!models.length) throw Object.assign(new Error('Antigravity returned no available models.'), { code: 'no_models_available' });
    return models;
  }

  openForSignIn() {
    const appPath = '/Applications/Antigravity.app';
    if (!fs.existsSync(appPath)) throw Object.assign(new Error('Antigravity.app is not installed at /Applications/Antigravity.app.'), { code: 'antigravity_app_missing' });
    const result = this.execFileSync('/usr/bin/open', ['-a', appPath], { encoding: 'utf8', timeout: 10000 });
    if (result.error || result.status !== 0) throw new Error('Could not open Antigravity.app.');
    return true;
  }

  async complete(model, messages, options = {}) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(model)) throw new Error('Invalid Antigravity model ID.');
    const prompt = messages.map(message => {
      const role = message.role === 'assistant' ? 'Assistant' : message.role === 'system' ? 'Instructions' : 'User';
      return `${role}: ${message.content}`;
    }).join('\n\n');
    const workspace = fs.mkdtempSync(path.join(this.tempDir, 'ai-router-antigravity-'));
    try {
      return await new Promise((resolve, reject) => {
        const child = this.spawn(this.cliPath, [
          '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model,
          '--settings', JSON.stringify({ toolPermission: 'strict', allowNonWorkspaceAccess: 'off' })
        ], { cwd: workspace, env: oauthOnlyEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
        let buffer = '';
        let response = '';
        let terminalResult = null;
        let started = false;
        let stderr = '';
        let settled = false;
        let timedOut = false;
        let safetyError = null;
        const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, options.timeoutMs || 120000);
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          error ? reject(error) : resolve(value);
        };
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
        child.stdout.on('data', chunk => {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (safetyError) return;
            let event;
            try { event = JSON.parse(line); } catch { continue; }
            if (event.event === 'init' && !started) {
              const init = event.init || {};
              if (path.resolve(init.cwd || '') !== path.resolve(workspace) || init.permission_mode !== 'strict') {
                safetyError = Object.assign(new Error('Antigravity session did not confirm the isolated workspace and strict tool policy.'), { code: 'antigravity_safety_unverified' });
                child.kill('SIGTERM');
                return;
              }
              started = true;
              child.stdin.end(`${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`);
            } else if (event.event === 'step_update' && event.step_update?.step_type === 'agent_response' && typeof event.step_update.text_delta === 'string') {
              response += event.step_update.text_delta;
              options.onText?.(event.step_update.text_delta);
            } else if (event.event === 'result') {
              terminalResult = event.result || {};
              if (terminalResult.status === 'SUCCESS' && typeof terminalResult.response === 'string' && !response) options.onText?.(terminalResult.response);
            }
          }
        });
        child.on('error', error => finish(Object.assign(new Error(`Antigravity CLI could not start: ${error.message}`), { code: 'antigravity_cli_unavailable' })));
        child.on('close', code => {
          if (settled) return;
          if (safetyError) return finish(safetyError);
          if (terminalResult?.status === 'SUCCESS' && typeof terminalResult.response === 'string') {
            return finish(null, { text: terminalResult.response, model, usage: terminalResult.usage });
          }
          if (terminalResult) return finish(Object.assign(new Error(terminalResult.error || 'Antigravity could not complete this request.'), { code: 'antigravity_request_failed' }));
          const message = timedOut ? 'Antigravity request timed out.' : code === 0 ? (stderr.trim() || 'Antigravity returned no response.') : (stderr.trim() || `Antigravity CLI exited with code ${code}.`);
          finish(Object.assign(new Error(message), { code: /authentication required|sign in/i.test(stderr) ? 'antigravity_auth_required' : 'antigravity_request_failed' }));
        });
      });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
}

module.exports = { AntigravityCli, oauthOnlyEnvironment };
