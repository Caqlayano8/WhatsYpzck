// Bot Status

window.loadBotStatus = async function () {
  const AS = window.AdminState;
  try {
    const data    = await apiFetch('/crm/bot/status');
    const dot     = document.getElementById('bot-status-dot');
    const text    = document.getElementById('bot-status-text');
    const details = document.getElementById('bot-status-details');
    const qrWrap  = document.getElementById('qr-container-wrap');
    const qrEl    = document.getElementById('qr-container');

    dot.className  = `status-dot ${data.status}`;
    text.textContent = data.status === 'connected' ? 'Bağlı'
                     : data.status === 'scanning'  ? 'QR Kodu Taranıyor'
                     : 'Bağlantı Kesildi';

    let html = '';
    if (data.phone)    html += `<div><span class="text-gray-400">Telefon:</span> <span class="font-medium">${escHtml(data.phone)}</span></div>`;
    if (data.pushName) html += `<div><span class="text-gray-400">Ad:</span> <span class="font-medium">${escHtml(data.pushName)}</span></div>`;
    details.innerHTML = html;

    if (data.uptime !== undefined) {
      const h = Math.floor(data.uptime / 3600);
      const m = Math.floor((data.uptime % 3600) / 60);
      const s = data.uptime % 60;
      document.getElementById('bot-uptime').textContent = `${h}h ${m}m ${s}s`;
    }

    if (data.status === 'scanning' && data.qrCode) {
      qrWrap.classList.remove('hidden');
      qrEl.innerHTML = '';
      if (AS.qrInstance) { try { AS.qrInstance.clear(); } catch (_) {} }
      if (typeof QRCode !== 'undefined') {
        AS.qrInstance = new QRCode(qrEl, { text: data.qrCode, width: 200, height: 200 });
      } else {
        qrEl.textContent = 'QR kütüphanesi mevcut değil';
      }
    } else {
      qrWrap.classList.add('hidden');
      if (AS.qrInstance) { try { AS.qrInstance.clear(); } catch (_) {} AS.qrInstance = null; }
    }
  } catch {
    showToast('Bot durumu yüklenemedi', 'error');
  }
};

window.reconnectBot = async function () {
  try {
    await apiFetch('/crm/bot/reconnect', 'POST');
    showToast('Bot yeniden bağlanıyor…', 'info');
    setTimeout(loadBotStatus, 3000);
  } catch {
    showToast('Yeniden bağlanma başarısız', 'error');
  }
};

// Live Logs (SSE)

function startLogStream() {
  const AS = window.AdminState;
  if (AS.logEventSource) return;
  const token = localStorage.getItem('token');
  AS.logEventSource = new EventSource(`/crm/logs/stream?token=${encodeURIComponent(token)}`);
  AS.logEventSource.onmessage = e => {
    try {
      const entry = JSON.parse(e.data);
      AS.logEntries.push(entry);
      if (AS.logEntries.length > 500) AS.logEntries.shift();
      appendLogLine(entry);
    } catch (_) {}
  };
}
window.startLogStream = startLogStream;

function stopLogStream() {
  const AS = window.AdminState;
  if (AS.logEventSource) { AS.logEventSource.close(); AS.logEventSource = null; }
}
window.stopLogStream = stopLogStream;

function appendLogLine(entry) {
  const AS = window.AdminState;
  const el = document.getElementById('log-output');
  if (!el) return;
  if (AS.logFilter !== 'all' && entry.level !== AS.logFilter) return;
  const colors = { error: '#f87171', warn: '#fbbf24', info: '#60a5fa', debug: '#a78bfa', verbose: '#6ee7b7' };
  const span = document.createElement('span');
  span.dataset.level = entry.level;
  span.style.color   = colors[entry.level] || '#cbd5e1';
  span.textContent   = `[${entry.timestamp}] ${(entry.level || '').toUpperCase()}: ${entry.message}\n`;
  el.appendChild(span);
  const autoScroll = document.getElementById('auto-scroll');
  if (!autoScroll || autoScroll.checked) el.scrollTop = el.scrollHeight;
}

window.setLogFilter = function (level) {
  const AS = window.AdminState;
  AS.logFilter = level;
  document.querySelectorAll('.log-filter-btn').forEach(btn => {
    const active = btn.dataset.level === level;
    btn.classList.toggle('bg-slate-700', active);
    btn.classList.toggle('text-white',   active);
    btn.classList.toggle('bg-gray-100',  !active);
    btn.classList.toggle('text-gray-600', !active);
  });
};

// ============ SESSION MANAGEMENT (PHASE 2) ============

function hasAdminRights() {
  const role = String(window.AdminState?.currentUser?.role || '').toLowerCase();
  // Role can be momentarily empty while auth check is resolving.
  // Keep UI responsive; backend keeps hard authorization checks.
  if (!role) return true;
  return role === 'admin';
}

function getSelectedSessionRef() {
  const selector = document.getElementById('session-selector');
  const raw = String(selector?.value || '').trim();
  if (!raw) return null;

  if (raw.includes(':')) {
    const idx = raw.indexOf(':');
    const tenantId = raw.slice(0, idx) || 'default';
    const sessionKey = raw.slice(idx + 1) || 'primary';
    return { tenantId, sessionKey };
  }

  const AS = window.AdminState;
  const found = (AS.sessions || []).find(s => s.sessionKey === raw);
  return {
    tenantId: found?.tenantId || 'default',
    sessionKey: raw
  };
}

window.loadSessions = async function () {
  try {
    const AS = window.AdminState;
    const selector = document.getElementById('session-selector');
    if (!selector) return;

    const tenantCodes = ['default'];
    try {
      const tenants = await apiFetch('/crm/tenants');
      if (Array.isArray(tenants)) {
        tenants.forEach(t => {
          const code = String(t?.code || '').trim().toLowerCase();
          const status = String(t?.status || '').toLowerCase();
          if (code && code !== 'default' && status !== 'inactive') tenantCodes.push(code);
        });
      }
    } catch (_) {
      // Tenant list optional; continue with default only
    }

    const allSessions = [];
    for (const tenantId of tenantCodes) {
      try {
        const list = await apiFetch(`/crm/tenant/sessions?tenantId=${encodeURIComponent(tenantId)}`);
        (list || []).forEach(s => allSessions.push(s));
      } catch (_) {
        // Ignore tenant-specific fetch failures to keep UI responsive
      }
    }

    const seen = new Set();
    const sessions = allSessions.filter(s => {
      const key = `${String(s?.tenantId || 'default')}:${String(s?.sessionKey || '')}`;
      if (!s?.sessionKey || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    selector.innerHTML = '<option value="">-- Seç --</option>';

    (sessions || []).forEach(s => {
      const option = document.createElement('option');
      const tenantId = String(s.tenantId || 'default');
      option.value = `${tenantId}:${s.sessionKey}`;
      let label = s.sessionName || s.sessionKey;
      if (s.status) label += ` (${s.status})`;
      label = `[${tenantId}] ${label}`;
      option.textContent = label;
      selector.appendChild(option);
    });

    AS.sessionsLoaded = true;
    AS.sessions = sessions || [];
  } catch (error) {
    console.warn('[bot-logs] Failed to load sessions:', error);
  }
};

window.updateSessionDetails = async function () {
  const AS = window.AdminState;
  try {
    const selected = getSelectedSessionRef();
    const sessionKey = selected?.sessionKey;
    const tenantId = selected?.tenantId || 'default';

    if (!sessionKey) {
      document.getElementById('session-details-area')?.classList.add('hidden');
      return;
    }

    const [session, metrics] = await Promise.all([
      apiFetch(`/crm/tenant/session/${sessionKey}?tenantId=${encodeURIComponent(tenantId)}`),
      apiFetch(`/crm/tenant/session/${sessionKey}/metrics?tenantId=${encodeURIComponent(tenantId)}`).catch(() => null)
    ]);
    if (!session) throw new Error('Session not found');

    const detailsArea = document.getElementById('session-details-area');
    detailsArea.classList.remove('hidden');

    // Update status badge
    const statusBadge = document.getElementById('session-status-badge');
    const statusMap = { connected: 'bg-green-600', scanning: 'bg-amber-600', disconnected: 'bg-gray-500', pending_qr: 'bg-blue-600' };
    statusBadge.className = `px-2 py-1 rounded text-white font-medium ${statusMap[session.status] || 'bg-gray-400'}`;
    statusBadge.textContent = session.status || '--';

    // Update details
    document.getElementById('session-phone').textContent = session.botPhone || '--';
    document.getElementById('session-pushname').textContent = session.botPushName || '--';
    document.getElementById('session-created').textContent = session.createdAt ? new Date(session.createdAt).toLocaleString('tr-TR') : '--';

    // Update metrics
    if (metrics) {
      const incidentEl = document.getElementById('session-incident-count');
      if (incidentEl) incidentEl.textContent = metrics.stats?.incidentCount ?? '--';
    }

    // Update QR if scanning
    const qrContainer = document.getElementById('session-qr-container');
    if (session.status === 'scanning' && session.qrCode) {
      qrContainer.innerHTML = '';
      const AS = window.AdminState;
      if (AS.sessionQrInstance) {
        try { AS.sessionQrInstance.clear(); } catch (_) {}
      }
      if (typeof QRCode !== 'undefined') {
        AS.sessionQrInstance = new QRCode(qrContainer, { text: session.qrCode, width: 150, height: 150 });
      } else {
        qrContainer.innerHTML = '<span class="text-xs text-gray-500">QR kodu yüklenemedi</span>';
      }
    } else {
      qrContainer.innerHTML = `<span class="text-xs text-gray-500">${session.status === 'connected' ? 'Bağlantı aktif' : 'QR kod bekleniyor'}</span>`;
      if (AS && AS.sessionQrInstance) {
        try { AS.sessionQrInstance.clear(); } catch (_) {}
        AS.sessionQrInstance = null;
      }
    }
  } catch (error) {
    showToast('Session detayları yüklenemedi', 'error');
    console.error('Session update error:', error);
  }
};

window.createNewSession = async function () {
  if (!hasAdminRights()) {
    showToast('Session işlemleri için admin yetkisi gerekli', 'warning');
    return;
  }
  // Populate tenant dropdown from API
  const modal = document.getElementById('session-create-modal');
  const tenantSel = document.getElementById('new-session-tenant');
  document.getElementById('new-session-key').value = '';
  document.getElementById('new-session-name').value = '';
  try {
    const tenants = await apiFetch('/crm/tenants', 'GET');
    if (Array.isArray(tenants) && tenants.length > 0) {
      tenantSel.innerHTML = tenants.map(t =>
        `<option value="${t.code}">${t.code}${t.name !== t.code ? ' — ' + t.name : ''}</option>`
      ).join('');
    } else {
      tenantSel.innerHTML = '<option value="default">default</option>';
    }
  } catch { tenantSel.innerHTML = '<option value="default">default</option>'; }
  modal.classList.remove('hidden');
};

window.closeSessionCreateModal = function () {
  document.getElementById('session-create-modal').classList.add('hidden');
};

window.submitSessionCreate = async function () {
  if (!hasAdminRights()) {
    showToast('Session işlemleri için admin yetkisi gerekli', 'warning');
    return;
  }
  const tenantId = document.getElementById('new-session-tenant').value || 'default';
  const rawKey = document.getElementById('new-session-key').value.trim();
  const sessionName = document.getElementById('new-session-name').value.trim();
  if (!rawKey) { showToast('Session anahtar adı zorunludur', 'warning'); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(rawKey)) { showToast('Sadece harf, rakam, tire ve alt çizgi kullanılabilir', 'warning'); return; }
  const sessionKey = rawKey.toLowerCase();
  try {
    await apiFetch('/crm/tenant/session', 'POST', { tenantId, sessionKey, sessionName: sessionName || sessionKey });
    closeSessionCreateModal();
    showToast('Session oluşturuldu. QR kodunu tarayınız.', 'success');
    await loadSessions();
    const sel = document.getElementById('session-selector');
    if (sel) { sel.value = `${tenantId}:${sessionKey}`; await updateSessionDetails(); }
  } catch (error) {
    showToast(error.message || 'Session oluşturulamadı', 'error');
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const addBtn = document.getElementById('session-add-btn');
  if (addBtn && !addBtn.dataset.boundSessionAdd) {
    addBtn.addEventListener('click', () => window.createNewSession());
    addBtn.dataset.boundSessionAdd = '1';
  }

  const submitBtn = document.getElementById('session-create-submit-btn');
  if (submitBtn && !submitBtn.dataset.boundSessionSubmit) {
    submitBtn.addEventListener('click', () => window.submitSessionCreate());
    submitBtn.dataset.boundSessionSubmit = '1';
  }
});

window.deleteSelectedSession = async function () {
  if (!hasAdminRights()) {
    showToast('Session işlemleri için admin yetkisi gerekli', 'warning');
    return;
  }
  try {
    const selected = getSelectedSessionRef();
    const sessionKey = selected?.sessionKey;
    const tenantId = selected?.tenantId || 'default';

    if (!sessionKey) {
      showToast('Lütfen silinecek session seçiniz', 'warning');
      return;
    }

    if (!confirm(`"${tenantId}:${sessionKey}" session'ı silmek istediğinizden emin misiniz?`)) return;

    await apiFetch(`/crm/tenant/session/${sessionKey}?tenantId=${encodeURIComponent(tenantId)}`, 'DELETE');
    showToast('Session silindi', 'success');
    await loadSessions();
    document.getElementById('session-details-area')?.classList.add('hidden');
  } catch (error) {
    showToast(error.message || 'Session silinemedi', 'error');
  }
};

window.reconnectSession = async function () {
  if (!hasAdminRights()) {
    showToast('Session işlemleri için admin yetkisi gerekli', 'warning');
    return;
  }
  try {
    const selected = getSelectedSessionRef();
    const sessionKey = selected?.sessionKey;
    const tenantId = selected?.tenantId || 'default';

    if (!sessionKey) {
      showToast('Lütfen session seçiniz', 'warning');
      return;
    }

    await apiFetch(`/crm/tenant/session/${sessionKey}/reconnect?tenantId=${encodeURIComponent(tenantId)}`, 'POST');
    showToast('Session yeniden bağlanıyor...', 'info');
    setTimeout(() => updateSessionDetails(), 2000);
  } catch (error) {
    showToast(error.message || 'Yeniden bağlanma başarısız', 'error');
  }
};

// Wire session selector change
document.addEventListener('DOMContentLoaded', () => {
  const selector = document.getElementById('session-selector');
  if (selector) {
    selector.addEventListener('change', updateSessionDetails);
  }
});

// Load sessions on bot tab activation
const origBotTabClick = window.showTab;
window.showTab = function (tabName, ...args) {
  if (tabName === 'bot' && !window.AdminState.sessionsLoaded) {
    loadSessions();
  }
  return origBotTabClick?.call(this, tabName, ...args);
};

window.renderLogs = function () {
  const AS = window.AdminState;
  const el = document.getElementById('log-output');
  if (!el) return;
  el.innerHTML = '';
  AS.logEntries.forEach(entry => appendLogLine(entry));
};

window.clearLogs = function () {
  const AS = window.AdminState;
  AS.logEntries = [];
  const el = document.getElementById('log-output');
  if (el) el.innerHTML = '';
};
