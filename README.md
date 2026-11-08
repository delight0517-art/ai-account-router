# AI Account Router (Priority Chain Router)

Local Sovereign AI Account Library & Failover Gateway (OpenRouter & OpenAI compatible).

Designed for seamless multi-account load-balancing, token quota protection, and background AI routing on macOS.

## Features
- **Auto-Failover Priority Engine**: Automatically switches between upstream AI accounts/models (ChatGPT, OpenRouter, Google Antigravity, Ollama) when limits or quota errors occur.
- **OpenAI Compatible Endpoint**: Exposes a local `/v1` endpoint on port `18880`.
- **Zero Token Waste**: Preserves local states and routes lightweight requests to local/cost-efficient engines.
- **Built-in Dashboard**: Access visual management UI at `http://localhost:18880`.

## Quick Start
```bash
git clone https://github.com/delight0517-art/ai-account-router.git
cd ai-account-router
npm install
npm start
```
