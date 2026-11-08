'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { OpenRouterCompatibleServer } = require('../src/server.js');

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 18880;
const server = new OpenRouterCompatibleServer({ port });

server.start().then(({ url }) => {
  console.log(`=======================================================`);
  console.log(`⚡️ Priority Chain Router (Account Library Engine) Active`);
  console.log(`Dashboard UI: ${url}`);
  console.log(`OpenRouter / OpenAI Base URL: ${url}/v1`);
  console.log(`=======================================================`);
});

process.on('SIGINT', () => {
  server.stop();
  process.exit(0);
});
