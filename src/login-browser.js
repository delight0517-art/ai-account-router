'use strict';

const { execFile } = require('node:child_process');

async function openLoginBrowser(value, options = {}) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.username || url.password) {
    throw new Error('Invalid ChatGPT sign-in URL.');
  }
  const run = options.execFile || execFile;
  await new Promise((resolve, reject) => {
    // `open URL` delegates to macOS's current default browser. Never use a
    // success callback as proof that its window became visible: the Router UI
    // always retains the authorization URL and a copy/paste fallback.
    run('/usr/bin/open', [url.href], { timeout: 3000 }, error => {
      if (error) reject(new Error('기본 브라우저에서 로그인 화면을 열지 못했습니다.'));
      else resolve();
    });
  });
}

module.exports = { openLoginBrowser };
