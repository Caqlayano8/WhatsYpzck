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

// Builds the media cell HTML for a row (images + GPS badges)
function buildMediaCell(row) {
  const parts = [];

  if (row.images && row.images.length) {
    const safeId = CSS.escape(row.id || '');
    parts.push(
      `<button onclick="openIncidentMedia('${escHtml(row.id || '')}')"
         class="inline-flex items-center gap-1 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-700 rounded-lg px-2 py-1 text-xs font-semibold transition-colors">
         <i class="fas fa-images text-xs"></i> ${row.images.length} Resim
       </button>`
    );
  }

  if (row.photoCoords) {
    const lat = Number(row.photoCoords.lat).toFixed(5);
    const lng = Number(row.photoCoords.lng).toFixed(5);
    parts.push(
      `<a href="https://maps.google.com/?q=${lat},${lng}" target="_blank" rel="noopener noreferrer"
          class="inline-flex items-center gap-1 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-700 rounded-lg px-2 py-1 text-xs font-semibold transition-colors" title="Fotograf GPS: ${lat}, ${lng}">
          <i class="fas fa-camera text-xs"></i> GPS
        </a>`
    );
  }

  if (row.locationCoords) {
    const lat = Number(row.locationCoords.lat).toFixed(5);
    const lng = Number(row.locationCoords.lng).toFixed(5);
    parts.push(
      `<a href="https://maps.google.com/?q=${lat},${lng}" target="_blank" rel="noopener noreferrer"
          class="inline-flex items-center gap-1 bg-orange-50 hover:bg-orange-100 border border-orange-200 text-orange-700 rounded-lg px-2 py-1 text-xs font-semibold transition-colors" title="Konum: ${lat}, ${lng}">
          <i class="fas fa-location-dot text-xs"></i> Konum
        </a>`
    );
  }

  if (!parts.length) {
    return '<span class="text-gray-300 text-xs">—</span>';
  }

  return `<div class="flex flex-wrap gap-1">${parts.join('')}</div>`;
}

// Opens a lightbox-style modal to preview incident images
function openIncidentMedia(incidentId) {
  const AS = window.AdminState;
  const row = (AS.incidents || []).find((r) => r.id === incidentId || r.incidentId === incidentId);
  if (!row || !row.images || !row.images.length) return;

  let existing = document.getElementById('incident-media-modal');
  if (existing) existing.remove();

  const imgHtml = row.images.map((url, i) => {
    const resolved = typeof resolveMediaUrl === 'function' ? resolveMediaUrl(url) : url;
    return `<a href="${escHtml(resolved)}" target="_blank" rel="noopener noreferrer">
      <img src="${escHtml(resolved)}" alt="Resim ${i + 1}"
           class="rounded-xl object-cover border border-gray-200 hover:opacity-90 transition-opacity cursor-pointer"
           style="width:160px;height:160px;"
           onerror="this.src='/public/img/broken.png'; this.onerror=null;">
    </a>`;
  }).join('');

  const coordsHtml = [
    row.photoCoords ? `<span class="inline-flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-2 py-1"><i class="fas fa-camera"></i> Fotograf GPS: <a href="https://maps.google.com/?q=${row.photoCoords.lat},${row.photoCoords.lng}" target="_blank" class="underline">${Number(row.photoCoords.lat).toFixed(6)}, ${Number(row.photoCoords.lng).toFixed(6)}</a></span>` : '',
    row.locationCoords ? `<span class="inline-flex items-center gap-1 text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-2 py-1"><i class="fas fa-location-dot"></i> Konum: <a href="https://maps.google.com/?q=${row.locationCoords.lat},${row.locationCoords.lng}" target="_blank" class="underline">${Number(row.locationCoords.lat).toFixed(6)}, ${Number(row.locationCoords.lng).toFixed(6)}</a></span>` : ''
  ].filter(Boolean).join('');

  const modal = document.createElement('div');
  modal.id = 'incident-media-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60';
  modal.innerHTML = `
    <div class="bg-white rounded-2xl shadow-2xl p-6 max-w-2xl w-full mx-4 relative" style="max-height:85vh;overflow-y:auto;">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-bold text-gray-900 text-base">Ariza Medyasi — ${escHtml(incidentId)}</h3>
        <button onclick="document.getElementById('incident-media-modal').remove()"
                class="text-gray-400 hover:text-gray-700 text-xl leading-none">&times;</button>
      </div>
      ${coordsHtml ? `<div class="flex flex-wrap gap-2 mb-4">${coordsHtml}</div>` : ''}
      <div class="flex flex-wrap gap-3">${imgHtml}</div>
    </div>`;

  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
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
        ${buildMediaCell(row)}
      </td>
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
