// Agresif Mod ve Kısıtlamalar
window.toggleAggressiveMode = async function () {
  try {
    await apiFetch('/crm/settings/aggressive-mode', 'POST');
    showToast('Agresif mod değiştirildi', 'success');
    loadSettings();
  } catch {
    showToast('Agresif mod değiştirilemedi', 'error');
  }
};

window.removeAllRestrictions = async function () {
  try {
    await apiFetch('/crm/settings/remove-restrictions', 'POST');
    showToast('Tüm kısıtlamalar kaldırıldı', 'success');
    loadSettings();
  } catch {
    showToast('Kısıtlamalar kaldırılamadı', 'error');
  }
};

document.addEventListener('DOMContentLoaded', function () {
  const btnAggressive = document.getElementById('btn-aggressive-mode');
  if (btnAggressive) btnAggressive.onclick = window.toggleAggressiveMode;
  const btnRemove = document.getElementById('btn-remove-restrictions');
  if (btnRemove) btnRemove.onclick = window.removeAllRestrictions;
});
// Commands

async function loadCommands() {
  const AS = window.AdminState;
  try {
    const [list, stats, settings] = await Promise.all([
      apiFetch('/crm/commands'),
      apiFetch('/crm/commands/stats').catch(() => ({})),
      apiFetch('/crm/settings').catch(() => null),
    ]);
    if (settings?.env?.ENV) {
      AS.commandPrefix = settings.env.ENV === 'production' ? '/' : '!';
    }
    renderCommands(list, stats);
  } catch {
    showToast('Komutlar yuklenemedi', 'error');
  }
}

function renderCommands(list, stats) {
  const AS = window.AdminState;
  const prefix = AS.commandPrefix || '/';
  const tbody = document.getElementById('commands-table-body');
  tbody.innerHTML = '';
  if (!list || !list.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="px-6 py-8 text-center text-sm text-gray-400">Komut bulunamadi</td></tr>`;
    return;
  }
  list.forEach(cmd => {
    const count = (stats && stats[cmd.name]) || 0;
    const tr = document.createElement('tr');
    tr.className = 'trow';
    tr.innerHTML = `
      <td class="px-6 py-3.5 text-sm font-mono font-semibold text-gray-800">${prefix}${escHtml(cmd.name)}</td>
      <td class="px-6 py-3.5 text-sm text-gray-600">${count}</td>
      <td class="px-6 py-3.5">
        <span class="text-xs font-bold px-2.5 py-1 rounded-full ${cmd.disabled ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-700'}">
          ${cmd.disabled ? 'Devre Disi' : 'Etkin'}
        </span>
      </td>
      <td class="px-6 py-3.5">
        <button onclick="toggleCommand('${escHtml(cmd.name)}')"
          class="text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors ${cmd.disabled ? 'border-green-200 text-green-700 hover:bg-green-50' : 'border-red-200 text-red-600 hover:bg-red-50'}">
          ${cmd.disabled ? 'Etkinlestir' : 'Devre Disi Birak'}
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.toggleCommand = async function (name) {
  try {
    await apiFetch(`/crm/commands/${encodeURIComponent(name)}`, 'PATCH');
    showToast('Komut guncellendi', 'success');
    loadCommands();
  } catch {
    showToast('Komut guncellenemedi', 'error');
  }
};

// Users

const USER_ROLE_META = {
  admin: { label: 'Admin', badge: 'bg-indigo-100 text-indigo-700' },
  field_tech: { label: 'Teknisyen', badge: 'bg-sky-100 text-sky-700' },
  viewer: { label: 'Kullanici', badge: 'bg-emerald-100 text-emerald-700' },
};

const TECH_PERMISSION_KEYS = [
  'canViewIncidents',
  'canUpdateIncidents',
  'canViewConversations',
  'canSendMessages',
  'canViewReports',
];

function roleDefaultPermissions(role) {
  if (role === 'admin') {
    return {
      canViewIncidents: true,
      canUpdateIncidents: true,
      canViewConversations: true,
      canSendMessages: true,
      canViewReports: true,
    };
  }
  if (role === 'field_tech') {
    return {
      canViewIncidents: true,
      canUpdateIncidents: true,
      canViewConversations: false,
      canSendMessages: false,
      canViewReports: true,
    };
  }
  return {
    canViewIncidents: true,
    canUpdateIncidents: false,
    canViewConversations: false,
    canSendMessages: false,
    canViewReports: true,
  };
}

function setUserPermissionControls(role, permissions = {}) {
  const wrap = document.getElementById('user-permissions-wrap');
  if (!wrap) return;

  const defaults = roleDefaultPermissions(role);
  const show = role === 'field_tech';
  wrap.classList.toggle('hidden', !show);

  TECH_PERMISSION_KEYS.forEach((key) => {
    const el = document.getElementById(`user-perm-${key}`);
    if (!el) return;
    const value = permissions[key] !== undefined ? permissions[key] : defaults[key];
    el.checked = Boolean(value);
    el.disabled = !show;
  });
}

function readUserPermissionControls(role) {
  const defaults = roleDefaultPermissions(role);
  if (role !== 'field_tech') return defaults;

  const out = { ...defaults };
  TECH_PERMISSION_KEYS.forEach((key) => {
    const el = document.getElementById(`user-perm-${key}`);
    if (!el) return;
    out[key] = Boolean(el.checked);
  });
  return out;
}

function userRoleLabel(role) {
  return USER_ROLE_META[role]?.label || role || '—';
}

function userRoleBadge(role) {
  return USER_ROLE_META[role]?.badge || 'bg-gray-100 text-gray-600';
}

async function loadUsers() {
  const AS = window.AdminState;
  try {
    AS.users = await apiFetch('/crm/users');
    renderUsers(AS.users);
  } catch {
    showToast('Kullanicilar yuklenemedi', 'error');
  }
}

function renderUsers(list) {
  const AS = window.AdminState;
  const tbody = document.getElementById('users-table-body');
  tbody.innerHTML = '';
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-8 text-center text-sm text-gray-400">Kullanici bulunamadi</td></tr>`;
    return;
  }
  list.forEach(u => {
    const isSelf = AS.currentUser && u._id === AS.currentUser._id;
    const tr = document.createElement('tr');
    tr.className = 'trow';
    tr.innerHTML = `
      <td class="px-6 py-3.5">
        <div class="text-sm font-semibold text-gray-800">${escHtml(u.username)}</div>
        <div class="text-xs text-gray-400">${escHtml(u.displayName || '—')}</div>
      </td>
      <td class="px-6 py-3.5">
        <span class="text-xs font-bold px-2.5 py-1 rounded-full ${userRoleBadge(u.role)}">
          ${userRoleLabel(u.role)}
        </span>
      </td>
      <td class="px-6 py-3.5 text-sm text-gray-500">${escHtml(u.phone || '—')}</td>
      <td class="px-6 py-3.5 text-sm text-gray-500">${fmtDate(u.createdAt)}</td>
      <td class="px-6 py-3.5">
        <div class="flex items-center gap-1">
          ${isSelf
            ? '<span class="text-xs text-gray-400 italic">Siz</span>'
            : `<button onclick="editUser('${u._id}')"
                 title="Duzenle"
                 class="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg text-xs">
                 <i class="fas fa-pen"></i>
               </button>
               <button onclick="deleteUser('${u._id}')" title="Sil"
                 class="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg text-xs">
                 <i class="fas fa-trash"></i>
               </button>`
          }
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.openUserModal = function (user = null) {
  const AS = window.AdminState;
  AS.currentUserId = user?._id || null;
  document.getElementById('user-modal-title').textContent = user ? 'Kullanici Duzenle' : 'Kullanici Ekle';
  document.getElementById('user-modal-id').value   = user?._id    || '';
  document.getElementById('user-username').value   = user?.username || '';
  document.getElementById('user-display-name').value = user?.displayName || '';
  document.getElementById('user-phone').value = user?.phone || '';
  document.getElementById('user-password').value   = '';
  document.getElementById('user-role').value       = user?.role    || 'viewer';
  setUserPermissionControls(user?.role || 'viewer', user?.permissions || {});
  document.getElementById('user-username').readOnly = !!user;
  document.getElementById('user-username').classList.toggle('bg-gray-100', !!user);
  document.getElementById('user-username-note').classList.toggle('hidden', !user);
  document.getElementById('user-password-wrap').classList.toggle('hidden', !!user);
  document.getElementById('user-modal').classList.remove('hidden');
};

window.closeUserModal = function () {
  const AS = window.AdminState;
  document.getElementById('user-modal').classList.add('hidden');
  AS.currentUserId = null;
};

window.saveUser = async function () {
  const username = document.getElementById('user-username').value.trim();
  const displayName = document.getElementById('user-display-name').value.trim();
  const phone = document.getElementById('user-phone').value.trim();
  const password = document.getElementById('user-password').value;
  const role     = document.getElementById('user-role').value;
  const permissions = readUserPermissionControls(role);
  const id       = document.getElementById('user-modal-id').value;

  if (!username) { showToast('Kullanici adi zorunludur', 'warning'); return; }
  if (!id && !password) { showToast('Yeni kullanici icin sifre zorunludur', 'warning'); return; }

  try {
    if (id) {
      await apiFetch(`/crm/users/${id}`, 'PUT', { role, displayName, phone, permissions });
      showToast('Kullanici guncellendi', 'success');
    } else {
      await apiFetch('/crm/auth/register', 'POST', { username, password, role, displayName, phone });
      showToast('Kullanici olusturuldu', 'success');
    }
    closeUserModal();
    loadUsers();
  } catch {
    showToast('Kullanici kaydedilemedi', 'error');
  }
};

window.editUser = function (id) {
  const AS = window.AdminState;
  const user = (AS.users || []).find(x => x._id === id);
  if (!user) return;
  openUserModal(user);
};

window.deleteUser = async function (id) {
  const AS = window.AdminState;
  const u = AS.users.find(x => x._id === id);
  if (!confirm(`"${u?.username}" kullanicisi silinsin mi? Bu islem geri alinamaz.`)) return;
  try {
    await apiFetch(`/crm/users/${id}`, 'DELETE');
    showToast('Kullanici silindi', 'success');
    loadUsers();
  } catch {
    showToast('Kullanici silinemedi', 'error');
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const roleEl = document.getElementById('user-role');
  if (!roleEl) return;
  roleEl.addEventListener('change', (e) => {
    const role = e?.target?.value || 'viewer';
    setUserPermissionControls(role, {});
  });
});

// Audit Logs

window.loadAuditLogs = async function (page = 1) {
  const AS = window.AdminState;
  AS.auditPage = page;
  const action   = encodeURIComponent(document.getElementById('audit-action-filter')?.value   || '');
  const resource = encodeURIComponent(document.getElementById('audit-resource-filter')?.value || '');
  try {
    const res = await apiFetch(`/crm/audit-logs?page=${page}&limit=20&action=${action}&resource=${resource}`);
    renderAuditLogs(res.data || [], res.meta || {});
  } catch {
    showToast('Denetim kayitlari yuklenemedi', 'error');
  }
};

function renderAuditLogs(logs, meta) {
  const tbody = document.getElementById('audit-table-body');
  tbody.innerHTML = '';
  document.getElementById('audit-total').textContent = meta.total || logs.length;

  if (!logs.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="px-5 py-8 text-center text-sm text-gray-400">Denetim kaydi bulunamadi</td></tr>`;
  } else {
    logs.forEach(l => {
      const details = l.details ? JSON.stringify(l.details).substring(0, 80) : '—';
      const tr = document.createElement('tr');
      tr.className = 'trow';
      tr.innerHTML = `
        <td class="px-5 py-2.5 text-xs text-gray-500 whitespace-nowrap">${fmtDate(l.timestamp)}</td>
        <td class="px-5 py-2.5 text-sm text-gray-700 font-semibold">${escHtml(l.username || '—')}</td>
        <td class="px-5 py-2.5"><span class="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full font-mono">${escHtml(l.action)}</span></td>
        <td class="px-5 py-2.5 text-xs text-gray-500">${escHtml(l.resource)}${l.resourceId ? ` #${l.resourceId.substring(0, 8)}…` : ''}</td>
        <td class="px-5 py-2.5 text-xs text-gray-400 font-mono truncate" style="max-width:200px;" title="${escHtml(JSON.stringify(l.details || ''))}">${escHtml(details)}</td>
      `;
      tbody.appendChild(tr);
    });
  }
  renderPagination(meta, loadAuditLogs, 'audit-pagination');
}

// Settings

function renderTemplatePreview(template, vars) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => vars[key] || '');
}

function updateNotificationPreview() {
  const institutionName = String(document.getElementById('notification-institution-name')?.value || 'Coruh EDAS Artvin Il Mudurlugu').trim();
  const signatureName = String(document.getElementById('notification-signature-name')?.value || 'C. Kurtoglu').trim();
  const closingLine = String(document.getElementById('notification-closing-line')?.value || 'Bilgilerinize sunariz.').trim();

  const whatsappTemplate = String(document.getElementById('notification-status-whatsapp-template')?.value || '').trim();
  const statusEmailTemplate = String(document.getElementById('notification-status-email-template')?.value || '').trim();
  const createdEmailTemplate = String(document.getElementById('notification-created-email-template')?.value || '').trim();

  const vars = {
    incidentId: 'ARZ-1773396737967',
    status: 'ISLEME_ALINDI',
    statusLabel: 'Isleme alindi',
    updatedAt: fmtDate(new Date()),
    note: 'Ekip sahaya yonlendirildi.',
    noteLine: 'Aciklama: Ekip sahaya yonlendirildi.',
    customerName: 'Caglayan Kurtoglu',
    customerPhone: '905458966096',
    customerEmail: 'ornek@domain.com',
    address: 'Carsi Mah. Sanayi Sokak',
    meterNo: '074838377',
    institutionName,
    signatureName,
    closingLine,
  };

  const whatsappPreview = renderTemplatePreview(whatsappTemplate, vars).replace(/\n{3,}/g, '\n\n').trim();
  const statusEmailPreview = renderTemplatePreview(statusEmailTemplate, vars).replace(/\n{3,}/g, '\n\n').trim();
  const createdEmailPreview = renderTemplatePreview(createdEmailTemplate, {
    ...vars,
    createdAt: fmtDate(new Date())
  }).replace(/\n{3,}/g, '\n\n').trim();

  const waEl = document.getElementById('notification-preview-whatsapp');
  const seEl = document.getElementById('notification-preview-status-email');
  const ceEl = document.getElementById('notification-preview-created-email');
  if (waEl) waEl.textContent = whatsappPreview || 'Onizleme icin bir mesaj sablonu yazin.';
  if (seEl) seEl.textContent = statusEmailPreview || 'Onizleme icin bir mesaj sablonu yazin.';
  if (ceEl) ceEl.textContent = createdEmailPreview || 'Onizleme icin bir mesaj sablonu yazin.';
}

function bindNotificationPreviewEvents() {
  const ids = [
    'notification-institution-name',
    'notification-signature-name',
    'notification-closing-line',
    'notification-status-whatsapp-template',
    'notification-status-email-template',
    'notification-created-email-template',
  ];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.oninput = updateNotificationPreview;
  });
}

window.copyNotificationPreview = async function (elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const text = String(el.textContent || '').trim();
  if (!text) {
    showToast('Kopyalanacak metin yok', 'warning');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('Onizleme metni kopyalandi', 'success');
  } catch {
    showToast('Kopyalama basarisiz oldu', 'error');
  }
};

async function loadSettings() {
  const AS = window.AdminState;
  try {
    const data = await apiFetch('/crm/settings');
    const keyIds = ['GEMINI_API_KEY', 'CHAT_GPT_API_KEY', 'ANTHROPIC_API_KEY', 'OPENWEATHERMAP_API_KEY', 'SHERPA_ONNX_ASR_ENCODER_PATH', 'SHERPA_ONNX_ASR_DECODER_PATH', 'SHERPA_ONNX_ASR_TOKENS_PATH', 'SHERPA_ONNX_TTS_MODEL_PATH', 'SHERPA_ONNX_TTS_TOKENS_PATH', 'SHERPA_ONNX_TTS_LEXICON_PATH'];

    const botInfoGrid = document.getElementById('bot-info-grid');
    botInfoGrid.innerHTML = [
      ['Ortam', data.env?.ENV],
      ['Port',        data.env?.PORT],
      ['Bot Adi',    data.botIdentity?.name || 'WhatsYpzck'],
      ['On Ek',      data.env?.ENV === 'production' ? '/' : '!'],
    ].map(([k, v]) => `
      <div class="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-3">
        <span class="text-sm text-gray-500">${k}</span>
        <span class="text-sm font-semibold text-gray-800">${v || '—'}</span>
      </div>
    `).join('');

    const keyLabels = {
      GEMINI_API_KEY:               'Gemini AI',
      ANTHROPIC_API_KEY:            'Claude / Anthropic',
      OPENWEATHERMAP_API_KEY:       'OpenWeatherMap',
      SHERPA_ONNX_ASR_ENCODER_PATH: 'Sherpa ASR encoder',
      SHERPA_ONNX_ASR_DECODER_PATH: 'Sherpa ASR decoder',
      SHERPA_ONNX_ASR_TOKENS_PATH:  'Sherpa ASR tokens',
      SHERPA_ONNX_TTS_MODEL_PATH:   'Sherpa TTS model',
      SHERPA_ONNX_TTS_TOKENS_PATH:  'Sherpa TTS tokens',
      SHERPA_ONNX_TTS_LEXICON_PATH: 'Sherpa TTS lexicon',
      CHAT_GPT_API_KEY:             'ChatGPT / OpenAI',
    };
    const statusGrid = document.getElementById('api-keys-status-grid');
    if (statusGrid) {
      statusGrid.innerHTML = Object.entries(keyLabels).map(([key, label]) => {
        const configured = data.env?.[key];
        return `
          <div class="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-3">
            <span class="text-sm text-gray-700 font-medium">${label}</span>
            <span class="text-xs font-bold px-2.5 py-1 rounded-full ${configured ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}">
              ${configured ? '✓ Yapilandirildi' : '✗ Eksik'}
            </span>
          </div>
        `;
      }).join('');
    }

    document.getElementById('setting-maxFileSizeMb').value = data.maxFileSizeMb ?? 150;
    document.getElementById('setting-defaultAudioAiCommand').value = data.defaultAudioAiCommand || 'chat';
    document.getElementById('incident-whatsapp-numbers').value = (data.incidentRouting?.whatsappNumbers || []).join('\n');
    document.getElementById('incident-email-recipients').value = (data.incidentRouting?.emails || []).join('\n');
    document.getElementById('notification-institution-name').value = data.notificationTemplates?.institutionName || 'Coruh EDAS Artvin Il Mudurlugu';
    document.getElementById('notification-signature-name').value = data.notificationTemplates?.signatureName || 'C. Kurtoglu';
    document.getElementById('notification-closing-line').value = data.notificationTemplates?.closingLine || 'Bilgilerinize sunariz.';
    document.getElementById('notification-status-whatsapp-template').value = data.notificationTemplates?.statusWhatsappTemplate || '';
    document.getElementById('notification-status-email-template').value = data.notificationTemplates?.statusEmailTemplate || '';
    document.getElementById('notification-created-email-template').value = data.notificationTemplates?.createdEmailTemplate || '';
    document.getElementById('bot-template-kvkk').value = data.botMessageTemplates?.kvkkMessage || '';
    document.getElementById('bot-template-welcome').value = data.botMessageTemplates?.welcomeMenuMessage || '';
    document.getElementById('bot-template-main-menu').value = data.botMessageTemplates?.mainMenuMessage || '';
    document.getElementById('bot-template-fault-category').value = data.botMessageTemplates?.faultCategoryMessage || '';
    document.getElementById('bot-template-incident-status-start').value = data.botMessageTemplates?.incidentStatusStartMessage || '';
    document.getElementById('bot-template-incident-status-result').value = data.botMessageTemplates?.incidentStatusResultTemplate || '';
    document.getElementById('bot-template-incident-closure-no-open').value = data.botMessageTemplates?.incidentClosureNoOpenMessage || '';
    document.getElementById('bot-template-incident-closure-selection').value = data.botMessageTemplates?.incidentClosureSelectionMessage || '';
    document.getElementById('bot-template-incident-closure-confirm').value = data.botMessageTemplates?.incidentClosureConfirmMessage || '';
    document.getElementById('bot-template-incident-closure-need-approval').value = data.botMessageTemplates?.incidentClosureNeedApprovalMessage || '';
    document.getElementById('bot-template-incident-closure-success').value = data.botMessageTemplates?.incidentClosureSuccessMessage || '';
    document.getElementById('bot-template-chat-media-preview').value = data.botMessageTemplates?.chatMediaPreviewText || 'Fotograf gonderildi';
    document.getElementById('bot-identity-name').value = data.botIdentity?.name || 'WhatsYpzck';
    document.getElementById('bot-identity-author').value = data.botIdentity?.author || 'Ç. Kurtoğlu';
    bindNotificationPreviewEvents();
    updateNotificationPreview();
    AS.autoDownloadEnabled = data.autoDownloadEnabled ?? true;
    const toggle = document.getElementById('toggle-autoDownload');
    if (AS.autoDownloadEnabled) toggle.classList.add('on'); else toggle.classList.remove('on');

    keyIds.forEach(k => {
      const el = document.getElementById(`key-${k}`);
      if (!el) return;
      const persistedValue = data.apiKeysDisplay?.[k] || '';
      el.value = persistedValue;
      el.dataset.persistedValue = persistedValue;
    });
  } catch {
    showToast('Ayarlar yuklenemedi', 'error');
  }
}

async function saveSettings() {
  const AS = window.AdminState;
  const maxFileSizeMb = parseInt(document.getElementById('setting-maxFileSizeMb').value, 10);

  if (isNaN(maxFileSizeMb) || maxFileSizeMb < 1 || maxFileSizeMb > 500) {
    showToast('Maksimum dosya boyutu 1 ile 500 MB arasinda olmalidir', 'error');
    return;
  }

  const defaultAudioAiCommand = document.getElementById('setting-defaultAudioAiCommand').value;
  const keyIds = ['GEMINI_API_KEY', 'CHAT_GPT_API_KEY', 'ANTHROPIC_API_KEY', 'OPENWEATHERMAP_API_KEY', 'SHERPA_ONNX_ASR_ENCODER_PATH', 'SHERPA_ONNX_ASR_DECODER_PATH', 'SHERPA_ONNX_ASR_TOKENS_PATH', 'SHERPA_ONNX_TTS_MODEL_PATH', 'SHERPA_ONNX_TTS_TOKENS_PATH', 'SHERPA_ONNX_TTS_LEXICON_PATH'];
  const incidentRouting = {
    whatsappNumbers: String(document.getElementById('incident-whatsapp-numbers')?.value || '')
      .split(/\r?\n|,|;/)
      .map(v => v.trim())
      .filter(Boolean),
    emails: String(document.getElementById('incident-email-recipients')?.value || '')
      .split(/\r?\n|,|;/)
      .map(v => v.trim())
      .filter(Boolean),
  };
  const notificationTemplates = {
    institutionName: String(document.getElementById('notification-institution-name')?.value || '').trim(),
    signatureName: String(document.getElementById('notification-signature-name')?.value || '').trim(),
    closingLine: String(document.getElementById('notification-closing-line')?.value || '').trim(),
    statusWhatsappTemplate: String(document.getElementById('notification-status-whatsapp-template')?.value || '').trim(),
    statusEmailTemplate: String(document.getElementById('notification-status-email-template')?.value || '').trim(),
    createdEmailTemplate: String(document.getElementById('notification-created-email-template')?.value || '').trim(),
  };
  const botMessageTemplates = {
    kvkkMessage: String(document.getElementById('bot-template-kvkk')?.value || '').trim(),
    welcomeMenuMessage: String(document.getElementById('bot-template-welcome')?.value || '').trim(),
    mainMenuMessage: String(document.getElementById('bot-template-main-menu')?.value || '').trim(),
    faultCategoryMessage: String(document.getElementById('bot-template-fault-category')?.value || '').trim(),
    incidentStatusStartMessage: String(document.getElementById('bot-template-incident-status-start')?.value || '').trim(),
    incidentStatusResultTemplate: String(document.getElementById('bot-template-incident-status-result')?.value || '').trim(),
    incidentClosureNoOpenMessage: String(document.getElementById('bot-template-incident-closure-no-open')?.value || '').trim(),
    incidentClosureSelectionMessage: String(document.getElementById('bot-template-incident-closure-selection')?.value || '').trim(),
    incidentClosureConfirmMessage: String(document.getElementById('bot-template-incident-closure-confirm')?.value || '').trim(),
    incidentClosureNeedApprovalMessage: String(document.getElementById('bot-template-incident-closure-need-approval')?.value || '').trim(),
    incidentClosureSuccessMessage: String(document.getElementById('bot-template-incident-closure-success')?.value || '').trim(),
    chatMediaPreviewText: String(document.getElementById('bot-template-chat-media-preview')?.value || '').trim(),
  };
  const apiKeys = {};
  keyIds.forEach(k => {
    const el = document.getElementById(`key-${k}`);
    const val = el?.value?.trim();
    const persisted = el?.dataset?.persistedValue || '';
    if (val && val !== persisted) apiKeys[k] = val;
  });
  const botIdentity = {
    name:   String(document.getElementById('bot-identity-name')?.value   || '').trim() || 'WhatsYpzck',
    author: String(document.getElementById('bot-identity-author')?.value || '').trim() || 'Ç. Kurtoğlu',
  };
  try {
    await apiFetch('/crm/settings', 'PUT', { maxFileSizeMb, autoDownloadEnabled: AS.autoDownloadEnabled, defaultAudioAiCommand, apiKeys, incidentRouting, notificationTemplates, botMessageTemplates, botIdentity });
    showToast('Ayarlar kaydedildi', 'success');
    loadSettings();
  } catch {
    showToast('Ayarlar kaydedilemedi', 'error');
  }
}

window.toggleAutoDownload = function () {
  const AS = window.AdminState;
  AS.autoDownloadEnabled = !AS.autoDownloadEnabled;
  const t = document.getElementById('toggle-autoDownload');
  if (AS.autoDownloadEnabled) t.classList.add('on'); else t.classList.remove('on');
};

// Direct Message

window.openMessageModal = function (phone, name) {
  const AS = window.AdminState;
  AS.currentRecipient = phone;
  document.getElementById('msg-recipient-label').textContent = `Alici: ${name || phone}`;
  document.getElementById('message-content').value = '';
  document.getElementById('message-modal').classList.remove('hidden');
};

window.closeMessageModal = function () {
  const AS = window.AdminState;
  document.getElementById('message-modal').classList.add('hidden');
  AS.currentRecipient = null;
};

window.sendPrivateMessage = async function () {
  const AS = window.AdminState;
  const message = document.getElementById('message-content').value.trim();
  if (!message || !AS.currentRecipient) return;
  try {
    await apiFetch('/crm/send-message', 'POST', { phoneNumber: AS.currentRecipient, message });
    showToast('Mesaj gonderildi', 'success');
    closeMessageModal();
  } catch {
    showToast('Mesaj gonderilemedi', 'error');
  }
};
