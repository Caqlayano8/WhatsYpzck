// Incident reports

const INCIDENT_STATUS_OPTIONS = [
  { value: 'ALINDI', label: 'Kayit alindi' },
  { value: 'INCELEMEDE', label: 'Incelemede' },
  { value: 'ISLEME_ALINDI', label: 'Isleme alindi' },
  { value: 'COZUMLENDI', label: 'Cozumlendi' },
  { value: 'KAPATILDI', label: 'Kapatildi' },
];

function incidentStatusLabel(status) {
  const found = INCIDENT_STATUS_OPTIONS.find((o) => o.value === status);
  return found ? found.label : 'Bilinmiyor';
}

async function loadIncidents() {
  const AS = window.AdminState;
  try {
    const q = encodeURIComponent(AS.incidentSearch || '');
    const res = await apiFetch(`/crm/incidents?q=${q}`);
    AS.incidents = res.data || [];
    renderIncidents(AS.incidents);
  } catch {
    showToast('Arıza raporları yüklenemedi', 'error');
  }
}

function renderIncidents(list) {
  const tbody = document.getElementById('incidents-table-body');
  const empty = document.getElementById('incidents-empty');
  if (!tbody || !empty) return;

  tbody.innerHTML = '';
  if (!list || !list.length) {
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.forEach((row) => {
    const tr = document.createElement('tr');
    tr.className = 'trow border-b border-gray-50';

    const optionsHtml = INCIDENT_STATUS_OPTIONS
      .map((opt) => `<option value="${opt.value}" ${row.status === opt.value ? 'selected' : ''}>${opt.label}</option>`)
      .join('');

    tr.innerHTML = `
      <td class="px-5 py-3 text-xs font-mono text-indigo-600 font-semibold">${escHtml(row.id || '—')}</td>
      <td class="px-5 py-3 text-xs text-gray-500">${fmtDate(row.createdAt)}</td>
      <td class="px-5 py-3 text-sm text-gray-800">${escHtml(row.customerName || '—')}</td>
      <td class="px-5 py-3 text-xs text-gray-600">${escHtml(row.phone || '—')}</td>
      <td class="px-5 py-3 text-xs text-gray-600">${escHtml(row.customerEmail || '—')}</td>
      <td class="px-5 py-3 text-xs text-gray-600" title="${escHtml(row.address || '')}">${escHtml((row.address || '—').slice(0, 80))}${(row.address || '').length > 80 ? '…' : ''}</td>
      <td class="px-5 py-3 text-xs text-gray-700 font-mono">${escHtml(row.meterNo || '—')}</td>
      <td class="px-5 py-3 text-xs text-gray-500">${escHtml(row.sourceNumber || '—')}</td>
      <td class="px-5 py-3 text-xs text-gray-700 font-semibold">${escHtml(incidentStatusLabel(row.status))}</td>
      <td class="px-5 py-3 text-xs text-gray-500">
        <div class="flex items-center gap-2">
          <select id="incident-status-${escHtml(row.id || '')}" class="field py-1 text-xs" style="min-width:140px;">
            ${optionsHtml}
          </select>
          <button onclick="updateIncidentStatus('${escHtml(row.id || '')}')" class="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1 rounded-lg text-xs font-semibold">Kaydet</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function updateIncidentStatus(incidentId) {
  const selectEl = document.getElementById(`incident-status-${incidentId}`);
  if (!selectEl) return;

  const status = selectEl.value;
  const note = prompt('Durum notu (opsiyonel):', '') || '';

  try {
    await apiFetch(`/crm/incidents/${encodeURIComponent(incidentId)}/status`, 'PATCH', { status, note });
    showToast('Ariza durumu guncellendi', 'success');
    await loadIncidents();
  } catch {
    showToast('Ariza durumu guncellenemedi', 'error');
  }
}

window.loadIncidents = loadIncidents;
window.updateIncidentStatus = updateIncidentStatus;
