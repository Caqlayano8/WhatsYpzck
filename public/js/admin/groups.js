async function loadGroups() {
  await Promise.all([
    loadRecapGroups(),
    loadContactGroups()
  ]);
}

async function loadRecapGroups() {
  const AS = window.AdminState;
  const select = document.getElementById('recap-group-select');
  if (!select) return;

  try {
    const groups = await apiFetch('/crm/groups');
    AS.recapGroups = groups;

    if (!groups.length) {
      select.innerHTML = '<option value="">Henuz grup mesaji bulunmadi</option>';
      return;
    }

    select.innerHTML = groups.map(g =>
      `<option value="${g.id}">${escHtml(g.name)} (${g.count} mesaj)</option>`
    ).join('');

    updateGroupStats();
  } catch {
    select.innerHTML = '<option value="">Gruplar yuklenemedi</option>';
    showToast('Grup ozetleri yuklenemedi', 'error');
  }
}

async function loadContactGroups() {
  const AS = window.AdminState;

  try {
    AS.contactGroups = await apiFetch('/crm/contact-groups');
    renderContactGroups();
    updateGroupScheduleOptions();
  } catch {
    showToast('Ozel gruplar yuklenemedi', 'error');
  }
}

function renderContactGroups() {
  const AS = window.AdminState;
  const tbody = document.getElementById('contact-groups-body');
  const empty = document.getElementById('contact-groups-empty');
  if (!tbody) return;

  const groups = AS.contactGroups || [];
  if (!groups.length) {
    tbody.innerHTML = '';
    empty?.classList.remove('hidden');
    return;
  }

  empty?.classList.add('hidden');
  tbody.innerHTML = groups.map(group => `
    <tr class="trow border-b border-gray-100">
      <td class="px-4 py-3">
        <div class="font-semibold text-gray-800">${escHtml(group.name)}</div>
        <div class="text-xs text-gray-400 mt-1">${escHtml(group.description || 'Aciklama yok')}</div>
      </td>
      <td class="px-4 py-3 text-sm text-gray-700">${group.memberCount || (group.memberPhones || []).length}</td>
      <td class="px-4 py-3 text-sm text-gray-600">${escHtml((group.addressKeywords || []).join(', ') || 'Yok')}</td>
      <td class="px-4 py-3">
        <span class="badge ${group.enabled ? 'badge-sent' : 'badge-draft'}">${group.enabled ? 'Aktif' : 'Pasif'}</span>
      </td>
      <td class="px-4 py-3">
        <div class="flex items-center gap-3 text-sm">
          <button onclick="editContactGroup('${group._id}')" class="text-indigo-600 hover:text-indigo-800 font-semibold">Duzenle</button>
          <button onclick="fillGroupMessageTarget('${group._id}')" class="text-green-600 hover:text-green-800 font-semibold">Mesaj Yaz</button>
          <button onclick="deleteContactGroup('${group._id}')" class="text-red-500 hover:text-red-700 font-semibold">Sil</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function updateGroupStats() {
  const AS = window.AdminState;
  const select = document.getElementById('recap-group-select');
  const stats  = document.getElementById('recap-group-stats');
  if (!select || !stats) return;

  const group = (AS.recapGroups || []).find(g => g.id === select.value);
  if (group) {
    const last = group.lastMessage ? new Date(group.lastMessage).toLocaleString('tr-TR') : '—';
    stats.textContent = `${group.count} mesaj kaydi var. Son hareket: ${last}`;
    stats.classList.remove('hidden');
  } else {
    stats.classList.add('hidden');
  }
}

async function generateRecap() {
  const groupId = document.getElementById('recap-group-select')?.value;
  const period  = document.getElementById('recap-period-select')?.value || '24h';

  if (!groupId) { showToast('Lutfen bir grup secin', 'error'); return; }

  const btn        = document.getElementById('recap-btn');
  const resultCard = document.getElementById('recap-result-card');
  const empty      = document.getElementById('recap-empty');
  const body       = document.getElementById('recap-result-body');
  const meta       = document.getElementById('recap-result-meta');
  const title      = document.getElementById('recap-result-title');
  const badge      = document.getElementById('recap-provider-badge');
  const badgeText  = document.getElementById('recap-provider-text');

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin text-xs"></i> Uretiliyor...';
  resultCard.classList.add('hidden');
  badge.classList.add('hidden');
  empty.classList.add('hidden');

  try {
    const data = await apiFetch(
      '/crm/groups/' + encodeURIComponent(groupId) + '/recap',
      'POST',
      { period }
    );

    if (!data.summary) {
      empty.innerHTML =
        '<i class="fas fa-inbox text-5xl mb-3 block"></i>' +
        '<p class="text-sm font-medium">Bu zaman araliginda mesaj bulunamadi</p>';
      empty.classList.remove('hidden');
      return;
    }

    const providerNames = { chat: 'Gemini', gpt: 'ChatGPT', claude: 'Claude' };
    badgeText.textContent =
      `${providerNames[data.provider] || data.provider} ile ozet olusturuldu. ${data.count} mesaj incelendi.`;
    badge.classList.remove('hidden');

    title.textContent  = `Ozet - ${data.groupName}`;
    meta.textContent   = `${data.label} - ${data.count} mesaj`;
    body.dataset.raw   = data.summary;
    body.innerHTML     = renderRecapMarkdown(data.summary);
    resultCard.classList.remove('hidden');
  } catch {
    showToast('Grup ozeti olusturulamadi', 'error');
    empty.innerHTML =
      '<i class="fas fa-exclamation-circle text-5xl mb-3 block"></i>' +
      '<p class="text-sm font-medium">Ozet olusturulamadi. Ayarlar ekranindan AI anahtarini kontrol edin.</p>';
    empty.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-magic text-xs"></i> Ozet Olustur';
  }
}

function copyRecap() {
  const el = document.getElementById('recap-result-body');
  const text = el?.dataset.raw || el?.innerText || '';
  navigator.clipboard.writeText(text)
    .then(() => showToast('Ozet kopyalandi', 'success'))
    .catch(() => showToast('Kopyalama basarisiz', 'error'));
}

window.saveContactGroup = async function () {
  const AS = window.AdminState;
  const name = document.getElementById('group-name').value.trim();
  const description = document.getElementById('group-description').value.trim();
  const addressKeywords = document.getElementById('group-address-keywords').value.trim();
  const memberPhones = document.getElementById('group-member-phones').value.trim();
  const enabled = document.getElementById('group-enabled').checked;

  if (!name) return showToast('Grup adi zorunludur', 'error');

  const body = { name, description, addressKeywords, memberPhones, enabled };

  try {
    if (AS.editingContactGroupId) {
      await apiFetch(`/crm/contact-groups/${AS.editingContactGroupId}`, 'PUT', body);
      showToast('Grup guncellendi', 'success');
    } else {
      await apiFetch('/crm/contact-groups', 'POST', body);
      showToast('Grup olusturuldu', 'success');
    }
    resetContactGroupForm();
    loadContactGroups();
  } catch {
    showToast('Grup kaydedilemedi', 'error');
  }
};

window.editContactGroup = function (id) {
  const AS = window.AdminState;
  const group = (AS.contactGroups || []).find(item => item._id === id);
  if (!group) return;

  AS.editingContactGroupId = id;
  document.getElementById('group-name').value = group.name || '';
  document.getElementById('group-description').value = group.description || '';
  document.getElementById('group-address-keywords').value = (group.addressKeywords || []).join(', ');
  document.getElementById('group-member-phones').value = (group.memberPhones || []).join('\n');
  document.getElementById('group-enabled').checked = group.enabled !== false;
  document.getElementById('group-form-title').textContent = 'Grubu Duzenle';
  document.getElementById('group-form-submit').textContent = 'Grubu Guncelle';
};

window.resetContactGroupForm = function () {
  const AS = window.AdminState;
  AS.editingContactGroupId = null;
  document.getElementById('group-name').value = '';
  document.getElementById('group-description').value = '';
  document.getElementById('group-address-keywords').value = '';
  document.getElementById('group-member-phones').value = '';
  document.getElementById('group-enabled').checked = true;
  document.getElementById('group-form-title').textContent = 'Yeni Ozel Grup';
  document.getElementById('group-form-submit').textContent = 'Grubu Kaydet';
};

window.deleteContactGroup = async function (id) {
  if (!confirm('Bu grup silinsin mi?')) return;
  try {
    await apiFetch(`/crm/contact-groups/${id}`, 'DELETE');
    showToast('Grup silindi', 'success');
    if (window.AdminState.editingContactGroupId === id) resetContactGroupForm();
    loadContactGroups();
  } catch {
    showToast('Grup silinemedi', 'error');
  }
};

window.fillGroupMessageTarget = function (id) {
  const group = (window.AdminState.contactGroups || []).find(item => item._id === id);
  if (!group) return;
  const select = document.getElementById('group-message-target');
  if (select) select.value = id;
  const title = document.getElementById('group-send-title');
  if (title) title.textContent = `"${group.name}" grubuna mesaj gonder`;
};

function updateGroupScheduleOptions() {
  const select = document.getElementById('group-message-target');
  if (!select) return;
  const groups = window.AdminState.contactGroups || [];
  select.innerHTML = '<option value="">Grup secin</option>' + groups.map(group =>
    `<option value="${group._id}">${escHtml(group.name)} (${group.memberCount || (group.memberPhones || []).length} kisi)</option>`
  ).join('');
}

window.sendGroupMessageNow = async function () {
  const groupId = document.getElementById('group-message-target').value;
  const message = document.getElementById('group-message-body').value.trim();
  if (!groupId) return showToast('Lutfen grup secin', 'error');
  if (!message) return showToast('Mesaj bos olamaz', 'error');

  try {
    const result = await apiFetch(`/crm/contact-groups/${groupId}/send-message`, 'POST', { message });
    document.getElementById('group-message-body').value = '';
    showToast(`${result.groupName} grubuna mesaj gonderildi`, 'success');
  } catch {
    showToast('Grup mesaji gonderilemedi', 'error');
  }
};

window.scheduleGroupMessage = async function () {
  const groupId = document.getElementById('group-message-target').value;
  const message = document.getElementById('group-message-body').value.trim();
  const scheduledAt = document.getElementById('group-message-at').value;

  if (!groupId) return showToast('Lutfen grup secin', 'error');
  if (!message) return showToast('Mesaj bos olamaz', 'error');
  if (!scheduledAt) return showToast('Tarih ve saat secin', 'error');
  if (new Date(scheduledAt) <= new Date()) return showToast('Tarih gelecekte olmali', 'error');

  try {
    await apiFetch(`/crm/contact-groups/${groupId}/schedule-message`, 'POST', { message, scheduledAt });
    document.getElementById('group-message-at').value = '';
    document.getElementById('group-message-body').value = '';
    showToast('Grup mesaji zamanlandi', 'success');
    if (typeof loadScheduledMessages === 'function') loadScheduledMessages();
  } catch {
    showToast('Grup mesaji zamanlanamadi', 'error');
  }
};

function renderRecapMarkdown(raw) {
  let html = String(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  html = html.replace(/\*\*([^*\n]+?)\*\*/g, '<strong class="recap-heading">$1</strong>');
  html = html.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  html = html.replace(/(^|\n)- /g, '$1<span class="recap-bullet">•</span> ');
  html = html.replace(/\n/g, '<br>');
  return html;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
