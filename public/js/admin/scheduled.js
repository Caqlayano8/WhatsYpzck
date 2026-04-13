// Scheduled Messages
// openScheduledModal / closeScheduledModal are defined inline in admin.ejs

async function loadScheduledMessages() {
  try {
    const msgs = await apiFetch('/crm/scheduled-messages');
    renderScheduledMessages(msgs);
  } catch {
    showToast('Zamanlanmis mesajlar yuklenemedi', 'error');
  }
}

function renderScheduledMessages(msgs) {
  const tbody = document.getElementById('scheduled-messages-body');
  const empty = document.getElementById('scheduled-messages-empty');
  if (!tbody) return;
  if (!msgs.length) {
    tbody.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  const statusBadge = s => ({
    pending:   '<span class="badge badge-scheduled">Bekliyor</span>',
    sent:      '<span class="badge badge-sent">Gonderildi</span>',
    failed:    '<span class="badge badge-failed">Basarisiz</span>',
    cancelled: '<span class="badge badge-draft">Iptal Edildi</span>',
  }[s] || s);
  tbody.innerHTML = msgs.map(m => `
    <tr class="trow border-b border-gray-100">
      <td class="px-5 py-3 text-sm">
        <div class="font-medium text-gray-800">${escHtml(m.groupName || m.contactName || m.phoneNumber || 'Grup mesaji')}</div>
        ${m.groupName
          ? `<div class="text-xs text-gray-400">${m.recipientCount || (m.recipientPhones || []).length} kisiye gidecek</div>`
          : (m.contactName ? `<div class="text-xs text-gray-400">${escHtml(m.phoneNumber)}</div>` : '')}
      </td>
      <td class="px-5 py-3 text-sm text-gray-600 max-w-xs truncate">${escHtml(m.message)}</td>
      <td class="px-5 py-3 text-sm text-gray-700">${fmtDate(m.scheduledAt)}</td>
      <td class="px-5 py-3">${statusBadge(m.status)}</td>
      <td class="px-5 py-3">
        ${m.status === 'pending' ? `<button onclick="deleteScheduledMessage('${m._id}')" class="text-xs text-red-500 hover:text-red-700 font-semibold"><i class="fas fa-trash"></i></button>` : ''}
      </td>
    </tr>`).join('');
}

window.openScheduledContactPicker = function () {
  const phone = prompt('Telefon numarasini girin:');
  if (phone) {
    document.getElementById('sched-phone').value = phone.replace(/\D/g, '');
  }
};

window.saveScheduledMessage = async function () {
  const phoneNumber = document.getElementById('sched-phone').value.trim().replace(/\D/g, '');
  const message     = document.getElementById('sched-message').value.trim();
  const scheduledAt = document.getElementById('sched-at').value;
  if (!phoneNumber) return showToast('Telefon numarasi zorunludur', 'error');
  if (!message)     return showToast('Mesaj zorunludur', 'error');
  if (!scheduledAt) return showToast('Zamanlama alani zorunludur', 'error');
  if (new Date(scheduledAt) <= new Date()) return showToast('Zamanlama saati gelecekte olmalidir', 'error');
  try {
    await apiFetch('/crm/scheduled-messages', 'POST', { phoneNumber, message, scheduledAt });
    closeScheduledModal();
    showToast('Mesaj zamanlandi', 'success');
    loadScheduledMessages();
  } catch {
    showToast('Mesaj zamanlanamadi', 'error');
  }
};

window.deleteScheduledMessage = async function (id) {
  if (!confirm('Bu zamanlanmis mesaj iptal edilsin mi?')) return;
  try {
    await apiFetch(`/crm/scheduled-messages/${id}`, 'DELETE');
    showToast('Zamanlanmis mesaj iptal edildi', 'success');
    loadScheduledMessages();
  } catch {
    showToast('Mesaj iptal edilemedi', 'error');
  }
};
