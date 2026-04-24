// Contacts
async function loadContacts(page = 1) {
  const AS = window.AdminState;
  AS.contactsPage = page;
  try {
    const mode = AS.contactViewMode || 'all';
    let url = `/crm/contacts?page=${page}&limit=20&search=${encodeURIComponent(AS.contactsSearch)}&viewMode=${encodeURIComponent(mode)}`;
    const { data, meta } = await apiFetch(url);
    AS.contacts = data;
    renderContacts(data);
    renderPagination(meta, loadContacts, 'contacts-pagination');
    document.getElementById('contacts-start').textContent = meta.total ? (meta.page - 1) * meta.limit + 1 : 0;
    document.getElementById('contacts-end').textContent   = Math.min(meta.page * meta.limit, meta.total);
    document.getElementById('contacts-total').textContent = meta.total;
  } catch {
    showToast('Kişiler yüklenemedi', 'error');
  }
}

window.filterContactView = function (mode) {
  const AS = window.AdminState;
  AS.contactViewMode = mode;
  document.querySelectorAll('.contact-filter-btn').forEach(btn => {
    btn.classList.remove('bg-indigo-600', 'text-white');
    btn.classList.add('bg-gray-100', 'text-gray-600', 'hover:bg-gray-200');
  });
  document.querySelectorAll('.contact-filter-btn').forEach(btn => {
    const onclick = btn.getAttribute('onclick') || '';
    if (onclick.includes(`'${mode}'`)) {
      btn.classList.remove('bg-gray-100', 'text-gray-600', 'hover:bg-gray-200');
      btn.classList.add('bg-indigo-600', 'text-white');
    }
  });
  loadContacts(1);
};

function renderContacts(contacts) {
  const tbody = document.getElementById('contacts-table-body');
  tbody.innerHTML = '';
  if (!contacts.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="px-6 py-10 text-center text-sm text-gray-400">Kişi bulunamadı</td></tr>`;
    return;
  }
  contacts.forEach(c => {
    const tagChips = (c.tags || []).map(t =>
      `<span class="inline-block bg-indigo-50 text-indigo-700 text-xs px-2 py-0.5 rounded-full font-medium">${escHtml(t)}</span>`
    ).join(' ');
    const blockedBadge  = c.blocked  ? `<span class="ml-1 text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full font-semibold">Engellendi</span>`  : '';
    const archivedBadge = c.archived ? `<span class="ml-1 text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full font-semibold">Arşivlendi</span>` : '';
    const fullName = [c.name, c.lastName].filter(Boolean).join(' ') || c.pushName || '—';
    const displayName = maskName(fullName);
    const addressText = c.address ? `<span class="text-gray-600 text-xs">${escHtml(c.address)}</span>` : `<span class="text-gray-300 text-xs">—</span>`;
    const tr = document.createElement('tr');
    tr.className = 'trow';
    tr.innerHTML = `
      <td class="px-5 py-3 text-sm text-gray-700 font-mono">${maskPhone(c.phoneNumber)}</td>
      <td class="px-5 py-3 text-sm text-gray-800 font-medium">${escHtml(displayName)}${blockedBadge}${archivedBadge}</td>
      <td class="px-5 py-3 text-sm max-w-xs" style="max-width:180px;white-space:normal;">${addressText}</td>
      <td class="px-5 py-3">${langBadge(c.detectedLanguage)}</td>
      <td class="px-5 py-3">
        <div class="flex flex-wrap gap-1 items-center">
          ${tagChips}
          <button onclick="openTagModal('${c._id}')" title="Etiketleri düzenle"
            class="text-xs text-indigo-500 hover:text-indigo-700 px-1.5 py-0.5 rounded hover:bg-indigo-50">
            <i class="fas fa-tag text-xs"></i>
          </button>
        </div>
      </td>
      <td class="px-5 py-3 text-sm text-gray-500">${fmtDate(c.lastInteraction)}</td>
      <td class="px-5 py-3">
        <div class="flex items-center gap-1">
          <button onclick="openContactEditModal(${JSON.stringify(c).replace(/"/g, '&quot;')})" data-contact-id="${c._id}"
            title="Kişiyi Düzenle" class="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors text-xs">
            <i class="fas fa-user-edit"></i>
          </button>
          <button onclick="openMessageModal('${c.phoneNumber}', '${escHtml(fullName)}')"
            title="Mesaj gönder" class="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-lg transition-colors text-xs">
            <i class="fas fa-paper-plane"></i>
          </button>
          <button onclick="toggleBlock('${c._id}')"
            title="${c.blocked ? 'Engeli Kaldır' : 'Engelle'}"
            class="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors text-xs">
            <i class="fas fa-${c.blocked ? 'lock-open' : 'lock'}"></i>
          </button>
          <button onclick="toggleArchive('${c._id}')"
            title="${c.archived ? 'Arşivden Çıkar' : 'Arşivle'}"
            class="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors text-xs">
            <i class="fas fa-${c.archived ? 'box-open' : 'archive'}"></i>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.exportContacts = async function () {
  const AS = window.AdminState;
  try {
    let url = '/crm/contacts/export';
    if (AS.contactViewMode === 'blocked')  url += '?showBlocked=true';
    if (AS.contactViewMode === 'archived') url += '?showArchived=true';
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'contacts.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch {
    showToast('Dışa aktarım başarısız', 'error');
  }
};

window.openImportModal= function () {
  document.getElementById('import-csv-content').value = '';
  document.getElementById('import-modal').classList.remove('hidden');
};
window.closeImportModal = function () {
  document.getElementById('import-modal').classList.add('hidden');
};
window.importContacts = async function () {
  const csv = document.getElementById('import-csv-content').value.trim();
  if (!csv) { showToast('Lütfen CSV içeriğini yapıştırın', 'warning'); return; }
  try {
    const res = await apiFetch('/crm/contacts/import', 'POST', { csv });
    showToast(`${res.inserted || 0} kişi içe aktarıldı`, 'success');
    closeImportModal();
    loadContacts(1);
  } catch {
    showToast('İçe aktarım başarısız', 'error');
  }
};

// Tags
window.openTagModal = function (contactId) {
  const AS = window.AdminState;
  AS.currentContactId = contactId;
  apiFetch(`/crm/contacts?page=1&limit=10000&showBlocked=true&showArchived=true`).then(({ data }) => {
    const c = data.find(x => x._id === contactId);
    AS.currentTags = c ? [...(c.tags || [])] : [];
    document.getElementById('tags-contact-label').textContent = c ? (c.name || c.pushName || c.phoneNumber) : contactId;
    renderTagChips();
    document.getElementById('tag-input').value = '';
    document.getElementById('tags-modal').classList.remove('hidden');
  }).catch(() => {
    AS.currentTags = [];
    renderTagChips();
    document.getElementById('tags-modal').classList.remove('hidden');
  });
};

function renderTagChips() {
  const AS = window.AdminState;
  const container = document.getElementById('tags-chip-container');
  container.innerHTML = '';
  AS.currentTags.forEach(tag => {
    const span = document.createElement('span');
    span.className = 'inline-flex items-center gap-1 bg-indigo-100 text-indigo-700 text-xs px-2.5 py-1 rounded-full font-medium';
    span.innerHTML = `${escHtml(tag)} <button type="button" onclick="removeTag('${escHtml(tag)}')" class="text-indigo-400 hover:text-indigo-700 leading-none font-bold">&times;</button>`;
    container.appendChild(span);
  });
}

window.removeTag = function (tag) {
  const AS = window.AdminState;
  AS.currentTags = AS.currentTags.filter(t => t !== tag);
  renderTagChips();
};

window.addTagFromInput = function () {
  const AS = window.AdminState;
  const input = document.getElementById('tag-input');
  const val = input.value.trim();
  if (val && !AS.currentTags.includes(val)) {
    AS.currentTags.push(val);
    renderTagChips();
  }
  input.value = '';
};

window.handleTagInput = function (e) {
  if (e.key === 'Enter') { e.preventDefault(); addTagFromInput(); }
};

window.closeTagsModal = function () {
  const AS = window.AdminState;
  document.getElementById('tags-modal').classList.add('hidden');
  AS.currentContactId = null;
};

window.saveTags = async function () {
  const AS = window.AdminState;
  if (!AS.currentContactId) return;
  try {
    await apiFetch(`/crm/contacts/${AS.currentContactId}/tags`, 'PATCH', { tags: AS.currentTags });
    showToast('Etiketler kaydedildi', 'success');
    closeTagsModal();
    loadContacts(AS.contactsPage);
  } catch {
    showToast('Etiketler kaydedilemedi', 'error');
  }
};

window.toggleBlock = async function (contactId) {
  const AS = window.AdminState;
  try {
    await apiFetch(`/crm/contacts/${contactId}/block`, 'PATCH');
    showToast('Kişi güncellendi', 'success');
    loadContacts(AS.contactsPage);
  } catch {
    showToast('Kişi güncellenemedi', 'error');
  }
};

window.toggleArchive = async function (contactId) {
  const AS = window.AdminState;
  try {
    await apiFetch(`/crm/contacts/${contactId}/archive`, 'PATCH');
    showToast('Kişi güncellendi', 'success');
    loadContacts(AS.contactsPage);
  } catch {
    showToast('Kişi güncellenemedi', 'error');
  }
};

// ── Rehber (Contact Edit) Modal ────────────────────────────────────────────
window.openContactEditModal = function (contact) {
  document.getElementById('contact-edit-id').value       = contact._id;
  document.getElementById('contact-edit-name').value     = contact.name     || '';
  document.getElementById('contact-edit-lastname').value = contact.lastName  || '';
  document.getElementById('contact-edit-phone').value    = contact.phoneNumber || '';
  document.getElementById('contact-edit-address').value  = contact.address   || '';
  document.getElementById('contact-edit-modal').classList.remove('hidden');
};

window.closeContactEditModal = function () {
  document.getElementById('contact-edit-modal').classList.add('hidden');
};

window.saveContactEdit = async function () {
  const AS = window.AdminState;
  const id       = document.getElementById('contact-edit-id').value;
  const name     = document.getElementById('contact-edit-name').value.trim();
  const lastName = document.getElementById('contact-edit-lastname').value.trim();
  const address  = document.getElementById('contact-edit-address').value.trim();
  try {
    await apiFetch(`/crm/contacts/${id}`, 'PUT', { name, lastName, address });
    showToast('Kişi bilgileri kaydedildi ✓', 'success');
    closeContactEditModal();
    loadContacts(AS.contactsPage);
  } catch {
    showToast('Kayıt başarısız', 'error');
  }
};

// Manuel kişi ekleme
window.openAddContactModal = function () {
  document.getElementById('add-contact-phone').value   = '';
  document.getElementById('add-contact-name').value    = '';
  document.getElementById('add-contact-lastname').value = '';
  document.getElementById('add-contact-address').value = '';
  document.getElementById('add-contact-modal').classList.remove('hidden');
};

window.closeAddContactModal = function () {
  document.getElementById('add-contact-modal').classList.add('hidden');
};

window.saveNewContact = async function () {
  const phone    = document.getElementById('add-contact-phone').value.trim();
  const name     = document.getElementById('add-contact-name').value.trim();
  const lastName = document.getElementById('add-contact-lastname').value.trim();
  const address  = document.getElementById('add-contact-address').value.trim();
  if (!phone) { showToast('Telefon numarası zorunludur', 'warning'); return; }
  try {
    await apiFetch('/crm/contacts', 'POST', { phoneNumber: phone, name, lastName, address });
    showToast('Kişi eklendi', 'success');
    closeAddContactModal();
    loadContacts(1);
  } catch (err) {
    showToast(err.message || 'Kişi eklenemedi', 'error');
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const addBtn = document.getElementById('contact-add-btn');
  if (addBtn && !addBtn.dataset.boundContactAdd) {
    addBtn.addEventListener('click', () => window.openAddContactModal());
    addBtn.dataset.boundContactAdd = '1';
  }

  const addSaveBtn = document.getElementById('add-contact-save-btn');
  if (addSaveBtn && !addSaveBtn.dataset.boundContactSave) {
    addSaveBtn.addEventListener('click', () => window.saveNewContact());
    addSaveBtn.dataset.boundContactSave = '1';
  }

  const editSaveBtn = document.getElementById('contact-edit-save-btn');
  if (editSaveBtn && !editSaveBtn.dataset.boundContactEditSave) {
    editSaveBtn.addEventListener('click', () => window.saveContactEdit());
    editSaveBtn.dataset.boundContactEditSave = '1';
  }

  const tbody = document.getElementById('contacts-table-body');
  if (tbody && !tbody.dataset.boundContactTable) {
    tbody.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const editBtn = target.closest('button[data-contact-id]');
      if (!editBtn) return;

      event.preventDefault();
      const contactId = editBtn.getAttribute('data-contact-id');
      const contact = (window.AdminState?.contacts || []).find((item) => item._id === contactId);
      if (contact) window.openContactEditModal(contact);
    });
    tbody.dataset.boundContactTable = '1';
  }
});

