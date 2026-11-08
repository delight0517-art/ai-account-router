'use strict';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function providerDetails(account) {
  const isChatGpt = account.provider === 'chatgpt-plan';
  const isAntigravity = account.provider === 'antigravity-cli';
  const isLocalAi = account.provider === 'local-openai-compatible' || Boolean(account.localAi);
  return {
    name: isChatGpt ? 'ChatGPT' : isAntigravity ? 'Google Antigravity' : isLocalAi ? '로컬 AI' : account.providerName || 'OpenAI 호환 API',
    glyph: isChatGpt ? '✳' : isAntigravity ? '◈' : isLocalAi ? '⌂' : '◇',
    modelRefresh: isChatGpt || isAntigravity
  };
}

function localAiModeLabel(mode) {
  return ({
    preferred: '1단계 · 주력 후보',
    learning: '평가 중 · 등급 미정',
    probing: '복구 확인 중 · 등급 재평가',
    reduced: '2단계 · 보조 사용',
    fallback: '2단계 · 보조 사용',
    excluded: '3단계 · 자동 제외'
  })[mode] || '상태 미확인';
}

function renderModelCatalog(account) {
  const id = escapeHtml(account.id);
  const available = Array.isArray(account.availableModels) ? account.availableModels : [];
  if (available.length) {
    return '<div class="model-catalog" role="group" aria-label="' + escapeHtml(account.name) + '에서 사용할 수 있는 모델">' +
      available.map(model => {
        const modelId = String(model.id ?? '');
        const selected = modelId === account.model;
        return '<button class="model-option" type="button" data-model-owner="' + id + '" data-model="' + escapeHtml(modelId) + '" aria-pressed="' + selected + '" aria-label="' + escapeHtml((model.name || modelId) + ' 모델 선택') + '">' +
          '<span class="model-option-copy"><span class="model-option-title">' + escapeHtml(model.name || modelId) + '</span>' +
          '<span class="model-option-id">' + escapeHtml(modelId) + '</span></span><span class="model-check" aria-hidden="true">✓</span></button>';
      }).join('') + '</div>';
  }
  if (account.model) {
    return '<div class="model-catalog" role="group" aria-label="수동 설정 모델">' +
      '<div class="model-option model-option-static"><span class="model-option-copy"><span class="model-option-title">' + escapeHtml(account.model) + '</span>' +
      '<span class="model-option-id">API 연결에서 직접 설정</span></span><span class="model-configured">설정됨</span></div></div>';
  }
  return '<div class="model-catalog-empty">계정에 연결한 뒤 모델 목록을 새로고침하세요.</div>';
}

function renderAccountRows(accounts, activeAccount) {
  const providers = accounts.filter(account => account.provider !== 'demo');
  if (!providers.length) {
    return '<div class="empty-state"><strong>아직 연결된 모델 제공자가 없습니다.</strong><span>ChatGPT 또는 Google 계정으로 로그인하거나 API 제공자를 추가하면, 그 계정에서 사용할 수 있는 모델이 여기에 표시됩니다.</span></div>';
  }

  const totalRanks = providers.length;
  return providers.map((account, index) => {
    const details = providerDetails(account);
    const accountId = escapeHtml(account.id);
    const subtitle = [account.name, account.email].filter(Boolean).join(' · ');
    const state = account.enabled === false ? '사용 안 함' : account.provider === 'chatgpt-plan' ? '로그인 상태는 실제 요청으로 확인됩니다' : account.localAi ? '로컬 주소 · 실제 응답 전까지 연결 미확인' : '연결됨 · 제공자 응답은 요청 전까지 미확인';
    const localAiStatus = account.localAi
      ? '<div class="local-ai-status" role="status"><strong>자동 판단 · ' + escapeHtml(localAiModeLabel(account.localAi.mode)) + '</strong><span>' + escapeHtml(account.localAi.reason) + '</span><small>최근 ' + account.localAi.sampleCount + '회 · 성공률 ' + (account.localAi.successRate === null ? '표본 없음' : Math.round(account.localAi.successRate * 100) + '%') + ' · P95 ' + (account.localAi.p95LatencyMs === null ? '미측정' : (account.localAi.p95LatencyMs / 1000).toFixed(1) + '초') + '</small></div>'
      : '';
    const rankActions = Array.from({ length: totalRanks }, (_, i) => i + 1).map(rank => '<button class="menu-item" type="button" data-set-rank="' + rank + '" data-account-id="' + accountId + '" ' + (index === rank - 1 ? 'disabled' : '') + '>' + rank + '순위로 지정</button>').join('');
    const actions = [
      rankActions,
      details.modelRefresh ? '<button class="menu-item" type="button" data-refresh-models="' + accountId + '">이 계정의 모델 새로고침</button>' : '',
      account.provider === 'chatgpt-plan' ? '<button class="menu-item" type="button" data-reconnect-chatgpt="' + accountId + '">ChatGPT 다시 로그인</button>' : '',
      '<button class="menu-item" type="button" data-account-id="' + accountId + '" data-percent="5">5% 쿼터 시뮬레이션</button>',
      '<button class="menu-item" type="button" data-account-id="' + accountId + '" data-percent="100">100% 쿼터 시뮬레이션</button>',
      '<button class="menu-item danger" type="button" data-disconnect="true" data-account-id="' + accountId + '">계정 연결 해제</button>'
    ].filter(Boolean).join('');
    return '<article class="provider-card" data-account-row="' + accountId + '">' +
      '<header class="provider-header"><div class="provider-main"><span class="provider-icon" aria-hidden="true">' + details.glyph + '</span>' +
      '<div class="provider-copy"><div class="provider-name">' + escapeHtml(details.name) + '</div>' +
      '<div class="provider-sub">' + escapeHtml(subtitle) + '</div><div class="provider-sub provider-status"><i class="status-dot ' + (account.enabled === false ? '' : 'ready') + '"></i>' + escapeHtml(state) + '</div></div></div>' +
      '<div class="provider-actions"><span class="rank-chip">' + (index + 1) + '순위</span>' +
      (account.id === activeAccount?.id ? '<span class="active-badge">현재 선택 경로</span>' : '') +
      '<button class="btn btn-icon" type="button" data-menu-trigger="' + accountId + '" aria-label="' + escapeHtml(account.name) + ' 계정 설정" aria-expanded="false">•••</button>' +
      '<div class="menu-popover" id="menu-' + accountId + '" hidden>' + actions + '</div></div></header>' +
      '<div class="account-models"><div class="models-heading"><strong>이 계정에서 사용 가능한 모델</strong>' +
      '<span class="model-display">' + escapeHtml(account.model || '선택된 모델 없음') + '</span></div>' + renderModelCatalog(account) + localAiStatus +
      '<p class="model-save-status" aria-live="polite"></p>' + (account.provider === 'chatgpt-plan' ? '<p class="reconnect-status" data-reconnect-status="' + accountId + '" aria-live="polite"></p>' : '') + '</div></article>';
  }).join('');
}

function renderPriorityChain(accounts, activeAccount) {
  const providers = accounts.filter(account => account.provider !== 'demo');
  if (!providers.length) {
    return '<div class="priority-tier priority-tier-empty"><span class="priority-rank">1순위</span>' +
      '<strong>연결된 계정 없음</strong><span>모델/공급자를 추가하면 여기에 배치됩니다.</span></div>';
  }
  return providers.map((account, index) => {
    const details = providerDetails(account);
    const tierClass = 'priority-tier priority-tier-' + (index + 1);
    return '<div class="' + tierClass + '" data-priority-account="' + escapeHtml(account.id) + '">' +
      '<span class="priority-rank">' + (index + 1) + '순위</span>' +
      (account.id === activeAccount?.id ? '<span class="active-badge">현재 선택 경로</span>' : '') +
      '<div class="priority-account"><span class="provider-icon" aria-hidden="true">' + details.glyph + '</span><span><strong>' + escapeHtml(details.name) + '</strong><small>' + escapeHtml(account.name) + '</small></span></div>' +
      '<div class="priority-model"><span>이 계정의 선택 모델</span><strong>' + escapeHtml(account.model || '모델 미설정') + '</strong></div>' +
      '<span class="priority-state">' + escapeHtml(account.enabled === false ? '사용 안 함' : '라우팅 순서') + '</span></div>';
  }).join('');
}

function renderDashboard(status, port, sharedAccounts = { state: 'unavailable', profiles: [] }) {
  const accounts = Array.isArray(status.accounts) ? status.accounts : [];
  const accountRows = renderAccountRows(accounts, status.activeAccount);
  const activeName = status.activeAccount?.provider === 'demo' ? '계정 대기 중' : status.activeAccount?.name || '계정 대기 중';
  return '<main class="shell"><header class="page-heading"><div class="breadcrumb">Only Chat 방식의 모델 관리 <span>›</span> AI Account Router</div>' +
    '<p class="eyebrow">CONNECTED PROVIDERS · LIVE CATALOGS</p><h1>Models</h1>' +
    '<p class="intro">연결한 계정이 실제로 제공하는 모델을 바로 확인하고, 사용할 계정과 우선순위를 정합니다.</p></header>' +
    '<section class="section-block" aria-labelledby="providers-title"><div class="section-head"><div><p class="section-kicker">01 / PROVIDERS</p><h2 id="providers-title">연결된 계정과 모델</h2></div>' +
    '<button class="btn btn-primary" id="open-connect" type="button">＋ 모델/공급자 추가</button></div>' +
    '<div class="provider-list" aria-label="연결된 AI 계정">' + accountRows + '</div>' +
    '<p id="order-error" class="status-message" role="status" aria-live="polite"></p></section>' +
    renderSharedAccounts(sharedAccounts) +
    '<section class="section-block priority-section" aria-labelledby="priority-title"><div class="section-head"><div><p class="section-kicker">02 / ROUTING</p><h2 id="priority-title">M-Oasis 우선순위</h2></div>' +
    '<span class="active-badge">' + escapeHtml(activeName) + '</span></div>' +
    '<p class="section-description">기기별 최근 연결 성공률과 지연으로 로컬 AI를 1단계 주력 후보, 2단계 보조, 3단계 자동 제외로 분류합니다. 5개 미만 표본은 평가 중으로 둡니다. 이 평가는 연결 안정성만 측정하며 답변 정확성을 보증하지 않습니다.</p>' +
    '<div class="priority-grid" aria-label="AI 계정 우선순위 1순위에서 3순위까지">' + renderPriorityChain(accounts, status.activeAccount) + '</div>' +
    '<div class="quota-routing-settings" aria-labelledby="quota-routing-title"><div><p class="section-kicker">AUTOMATIC FAILOVER</p><h3 id="quota-routing-title">사용량 전환 기준</h3></div>' +
    '<p class="section-description">남은 사용량이 기준보다 낮으면 다음 우선순위 계정으로 전환합니다. 제공자 응답의 reset 시간이 있으면 그 값을 따르고, 없으면 아래 시간 뒤에 다시 사용할 수 있습니다. 계정을 바꿔 재시도할 때도 Only Chat의 이전 대화와 도구 결과를 함께 전달합니다.</p>' +
    '<form class="quota-limits-form" method="post" action="/api/v1/account-chain/limits"><input type="hidden" name="expectedRevision" value="' + Number(status.revision || 0) + '">' +
    '<label>전환 기준 (%)<input type="number" name="thresholdPercent" min="0" max="100" step="1" required value="' + Number(status.thresholdPercent ?? 10) + '"></label>' +
    '<label>기본 reset 시간 (시간)<input type="number" name="quotaResetHours" min="1" max="24" step="1" required value="' + Number(status.quotaResetHours ?? 5) + '"></label>' +
    '<button class="btn btn-primary" type="submit">전환 기준 저장</button></form></div></section>' +
    '<details class="endpoint-details"><summary>다른 앱에서 AI Router 연결하기</summary><div class="endpoint-box">Base URL: http://127.0.0.1:' + Number(port) + '/v1<br>API 키: macOS Keychain에 보관</div></details></main>' +
    '<dialog id="connect-modal" aria-labelledby="connect-title"><div class="modal-head"><div><p class="section-kicker">ADD MODEL SOURCE</p><h2 id="connect-title">모델 또는 공급자 추가</h2></div>' +
    '<button class="btn btn-icon" id="close-connect" type="button" aria-label="닫기">×</button></div>' +
    '<div class="modal-body"><p class="connect-intro">로그인한 계정의 모델은 자동으로 가져옵니다. 직접 입력한 API 모델은 해당 계정에만 연결됩니다.</p><div class="connect-choices" id="connect-choices">' +
    '<button class="connect-choice" type="button" data-connect-choice="chatgpt"><span class="provider-icon">✳</span><span><strong>ChatGPT 계정</strong><small>로그인 후 계정에서 사용할 수 있는 모델 가져오기</small></span><span class="choice-arrow">›</span></button>' +
    '<button class="connect-choice" type="button" data-connect-choice="antigravity"><span class="provider-icon">◈</span><span><strong>Google Antigravity 계정</strong><small>공식 앱 로그인 상태를 확인하고 모델 가져오기</small></span><span class="choice-arrow">›</span></button>' +
    '<button class="connect-choice" type="button" data-connect-choice="api"><span class="provider-icon">◇</span><span><strong>다른 API 제공자</strong><small>HTTPS 주소, 모델 ID, API 키 입력</small></span><span class="choice-arrow">›</span></button></div>' +
    '<section class="connect-panel" data-connect-panel="chatgpt" hidden><button class="btn btn-back" type="button" data-connect-back>‹ 뒤로 가기</button><div id="oauth-form-host"></div></section>' +
    '<section class="connect-panel" data-connect-panel="antigravity" hidden><button class="btn btn-back" type="button" data-connect-back>‹ 뒤로 가기</button><div id="antigravity-form-host"></div></section>' +
    '<section class="connect-panel" data-connect-panel="api" hidden><button class="btn btn-back" type="button" data-connect-back>‹ 뒤로 가기</button><div id="provider-form-host"></div></section></div></dialog>';
}

function renderSharedAccounts(shared = {}) {
  const profiles = Array.isArray(shared.profiles) ? shared.profiles : [];
  const content = profiles.length ? '<div class="shared-account-list">' + profiles.map(profile =>
    '<article class="shared-account-card"><div><strong>' + escapeHtml(profile.providerName || profile.provider) + '</strong><span>' + escapeHtml(profile.email) + '</span></div><div class="shared-device-list">' +
    (Array.isArray(profile.devices) ? profile.devices : []).map(device => '<span class="shared-device' + (profile.connectedHere && device.name === shared.currentDevice ? ' is-current' : '') + '">' + escapeHtml(device.name) + '</span>').join('') +
    '<span class="shared-local-state">' + (profile.connectedHere ? '이 기기에 계정 등록됨' : '다른 기기 등록 기록') + '</span></div></article>'
  ).join('') + '</div>' : '<p class="shared-empty">' + (shared.state === 'available' ? '공유된 로그인 계정이 없습니다.' : shared.reason ? escapeHtml(shared.reason) : 'Google Drive의 내 드라이브를 사용할 수 없습니다.') + '</p>';
  return '<section class="section-block shared-accounts-section" aria-labelledby="shared-accounts-title"><div class="section-head"><div><p class="section-kicker">03 / DEVICES</p><h2 id="shared-accounts-title">기기 간 로그인 계정</h2></div><button class="btn" id="refresh-shared-accounts" type="button">목록 새로고침</button></div>' +
    '<p class="section-description">같은 비공개 Google Drive 폴더를 Mac과 Windows에서 사용하면 Router에 등록된 계정 표시가 합쳐집니다. 로그인 순서와 모델은 공유하지 않으며, 인증 토큰은 각 기기에만 저장됩니다. 이 목록은 등록 기록이며 원격 기기의 현재 로그인 유효성을 실시간 확인하지 않습니다.</p>' + content +
    '<p id="shared-account-status" class="status-message" role="status" aria-live="polite"></p></section>';
}

module.exports = { escapeHtml, providerDetails, localAiModeLabel, renderModelCatalog, renderAccountRows, renderPriorityChain, renderDashboard, renderSharedAccounts };
