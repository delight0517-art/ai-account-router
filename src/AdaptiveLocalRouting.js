'use strict';

const MAX_OBSERVATIONS = 20;
const MIN_OBSERVATIONS = 5;
const LOCAL_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;

function isLocalProviderAccount(account) {
  if (!account || typeof account !== 'object') return false;
  if (!['local-openai-compatible', 'ollama', 'local', 'openai-compatible'].includes(account.provider)
    || typeof account.baseUrl !== 'string') return false;
  try {
    const url = new URL(account.baseUrl);
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function recordLocalObservation(current, ok, latencyMs, now = Date.now()) {
  const previous = current && typeof current === 'object' ? current : {};
  const observations = Array.isArray(previous.observations)
    ? previous.observations.filter(item => item && typeof item.ok === 'boolean'
      && Number.isFinite(item.latencyMs) && item.latencyMs >= 0 && Number.isFinite(item.at)).slice(-MAX_OBSERVATIONS + 1)
    : [];
  const observation = { ok: ok === true, latencyMs: Math.max(0, Math.min(120_000, Math.round(Number(latencyMs) || 0))), at: now };
  const consecutiveFailures = observation.ok ? 0 : Math.max(0, Number(previous.consecutiveFailures) || 0) + 1;
  const cooldownUntil = observation.ok
    ? 0
    : consecutiveFailures >= 3 ? now + LOCAL_FAILURE_COOLDOWN_MS : Math.max(0, Number(previous.cooldownUntil) || 0);
  return { observations: [...observations, observation], consecutiveFailures, cooldownUntil };
}

function summarizeLocalPerformance(performance, now = Date.now()) {
  const observations = Array.isArray(performance?.observations)
    ? performance.observations.filter(item => item && typeof item.ok === 'boolean'
      && Number.isFinite(item.latencyMs) && item.latencyMs >= 0 && Number.isFinite(item.at)).slice(-MAX_OBSERVATIONS)
    : [];
  const successes = observations.filter(item => item.ok).length;
  const latencies = observations.filter(item => item.ok).map(item => item.latencyMs).sort((a, b) => a - b);
  const successRate = observations.length ? successes / observations.length : null;
  const p95LatencyMs = latencies.length ? latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] : null;
  const cooldownUntil = Math.max(0, Number(performance?.cooldownUntil) || 0);
  let mode = 'learning';
  let reason = '첫 5개 응답의 연결 성공률과 응답 지연을 측정합니다.';

  if (cooldownUntil > now) {
    mode = 'excluded';
    reason = '최근 연속 연결 실패로 15분간 로컬 모델을 자동 라우팅에서 제외했습니다.';
  } else if ((Number(performance?.consecutiveFailures) || 0) >= 3) {
    mode = 'probing';
    reason = '대기 시간이 지나 간단한 요청으로 연결을 다시 확인합니다.';
  } else if (observations.length >= MIN_OBSERVATIONS) {
    if (successRate >= 0.9 && p95LatencyMs <= 15_000) {
      mode = 'preferred';
      reason = '최근 연결 성공률이 높고 응답 지연이 안정적입니다.';
    } else if (successRate >= 0.7 && p95LatencyMs <= 30_000) {
      mode = 'reduced';
      reason = '성능이 보통이어서 간단한 요청 위주로 사용합니다.';
    } else if (successRate < 0.5) {
      mode = 'excluded';
      reason = '최근 응답 성공률이 50% 미만이라 자동 경로에서 제외했습니다.';
    } else {
      mode = 'fallback';
      reason = '응답 지연이나 실패가 잦아 다른 연결을 먼저 시도합니다.';
    }
  }

  return {
    mode,
    reason,
    sampleCount: observations.length,
    successRate,
    p95LatencyMs,
    lastLatencyMs: observations.at(-1)?.latencyMs ?? null,
    cooldownUntil: cooldownUntil > now ? cooldownUntil : null
  };
}

function classifyRequestComplexity(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const inputChars = messages.reduce((total, message) => {
    const content = message?.content;
    if (typeof content === 'string') return total + content.length;
    if (Array.isArray(content)) return total + content.reduce((sum, item) => sum + (typeof item?.text === 'string' ? item.text.length : 0), 0);
    return total;
  }, 0);
  const hasTools = (Array.isArray(body?.tools) && body.tools.length > 0)
    || (body?.tool_choice !== undefined && body.tool_choice !== 'none');
  return hasTools || inputChars > 8_000 || Number(body?.max_tokens) > 4_096
    || ['high', 'max'].includes(String(body?.reasoning_effort || '').toLowerCase())
    ? 'complex' : 'simple';
}

function localRouteMode(account, health, { now = Date.now(), requestComplexity = 'simple', explicitlySelected = false } = {}) {
  if (!isLocalProviderAccount(account)) return 'normal';
  if (explicitlySelected) return 'preferred';
  const decision = summarizeLocalPerformance(health?.localPerformance, now);
  if (decision.mode === 'excluded') return 'excluded';
  if (decision.mode === 'fallback') return 'fallback';
  if (requestComplexity === 'complex' && decision.mode !== 'preferred') return 'fallback';
  return decision.mode;
}

module.exports = {
  MAX_OBSERVATIONS,
  MIN_OBSERVATIONS,
  LOCAL_FAILURE_COOLDOWN_MS,
  isLocalProviderAccount,
  recordLocalObservation,
  summarizeLocalPerformance,
  classifyRequestComplexity,
  localRouteMode
};
