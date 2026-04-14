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
          <button onclick="openIncidentStatusModal('${escHtml(row.id || '')}')" class="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1 rounded-lg text-xs font-semibold">Kaydet</button>
          <button onclick="openIncidentDetail('${escHtml(row.id || '')}')"  class="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1 rounded-lg text-xs font-semibold border border-slate-200">Detay</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function closeIncidentStatusModal() {
  const modal = document.getElementById('incident-status-modal');
  const form = document.getElementById('incident-status-form');
  if (form) form.reset();
  if (modal) modal.classList.add('hidden');
}

function openIncidentStatusModal(incidentId) {
  const selectEl = document.getElementById(`incident-status-${incidentId}`);
  if (!selectEl) return;

  const status = selectEl.value;

  const modal = document.getElementById('incident-status-modal');
  const incidentIdEl = document.getElementById('incident-status-id');
  const statusEl = document.getElementById('incident-status-value');
  const statusLabelEl = document.getElementById('incident-status-selected');
  const noteEl = document.getElementById('incident-status-note');

  if (!modal || !incidentIdEl || !statusEl || !statusLabelEl || !noteEl) return;

  incidentIdEl.value = incidentId;
  statusEl.value = status;
  statusLabelEl.textContent = incidentStatusLabel(status);
  noteEl.value = '';

  const mediaEl = document.getElementById('incident-status-media');
  if (mediaEl) mediaEl.value = '';

  modal.classList.remove('hidden');
}

async function submitIncidentStatusForm(event) {
  event.preventDefault();

  const incidentId = document.getElementById('incident-status-id')?.value || '';
  const status = document.getElementById('incident-status-value')?.value || '';
  const note = (document.getElementById('incident-status-note')?.value || '').trim();
  const mediaInput = document.getElementById('incident-status-media');
  const mediaFile = mediaInput?.files?.[0] || null;

  if (!incidentId || !status) {
    showToast('Kayit bilgisi eksik', 'warning');
    return;
  }

  if (!note) {
    showToast('Durum notu zorunludur', 'warning');
    return;
  }

  if (status === 'KAPATILDI' && !mediaFile) {
    showToast('Kaydi kapatirken resim veya video eklemek zorunlu', 'warning');
    return;
  }

  const formData = new FormData();
  formData.append('status', status);
  formData.append('note', note);
  if (mediaFile) {
    formData.append('media', mediaFile);
  }

  try {
    const res = await fetch(`/crm/incidents/${encodeURIComponent(incidentId)}/status`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${localStorage.getItem('token')}`,
      },
      body: formData,
    });

    if (!res.ok) {
      let message = 'Ariza durumu guncellenemedi';
      try {
        const err = await res.json();
        if (err?.error) message = String(err.error);
      } catch {
        // ignore
      }
      throw new Error(message);
    }

    showToast('Ariza durumu guncellendi', 'success');
    closeIncidentStatusModal();
    await loadIncidents();
  } catch (error) {
    showToast(error?.message || 'Ariza durumu guncellenemedi', 'error');
  }
}

if (!window.__incidentStatusFormBound) {
  const form = document.getElementById('incident-status-form');
  if (form) {
    form.addEventListener('submit', submitIncidentStatusForm);
    window.__incidentStatusFormBound = true;
  }
}

window.loadIncidents = loadIncidents;
function openIncidentDetail(incidentId) {
  const AS = window.AdminState;
  const row = (AS.incidents || []).find((r) => r.id === incidentId || r.incidentId === incidentId);
  if (!row) return;

  let existing = document.getElementById('incident-detail-modal');
  if (existing) existing.remove();

  const hasPhotos = Array.isArray(row.images) && row.images.length > 0;
  const lat = (row.locationCoords && row.locationCoords.lat) || (row.photoCoords && row.photoCoords.lat);
  const lng = (row.locationCoords && row.locationCoords.lng) || (row.photoCoords && row.photoCoords.lng);
  const hasLocation = lat && lng;

  const photosHtml = hasPhotos
    ? row.images.map((url, i) => {
        const resolved = (typeof resolveMediaUrl === 'function') ? resolveMediaUrl(url) : url;
        return '<a href="' + resolved + '" target="_blank" rel="noopener noreferrer">' +
          '<img src="' + resolved + '" alt="Resim ' + (i+1) + '" ' +
               'style="width:160px;height:160px;border-radius:12px;object-fit:cover;border:1px solid #e5e7eb;cursor:pointer;" ' +
               'onerror="this.parentElement.innerHTML=\'<div style=width:160px;height:160px;background:#f1f5f9;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#94a3b8;>Yuklenemedi</div>\'">' +
        '</a>';
      }).join('')
    : '<div style="text-align:center;padding:24px 0;color:#9ca3af;"><span style="font-size:32px;">&#128247;</span><p style="margin-top:8px;font-size:13px;">Bu kayit icin fotograf paylasılmadı</p></div>';

  const mapHtml = hasLocation
    ? '<div>' +
        '<p style="font-size:11px;color:#6b7280;margin-bottom:8px;">GPS: ' + Number(lat).toFixed(6) + ', ' + Number(lng).toFixed(6) + '</p>' +
        '<a href="https://maps.google.com/?q=' + lat + ',' + lng + '" target="_blank" rel="noopener noreferrer">' +
          '<img src="https://static-maps.yandex.ru/1.x/?ll=' + lng + ',' + lat + '&z=15&l=map&size=600,250&pt=' + lng + ',' + lat + ',pm2rdl" ' +
               'alt="Harita" style="width:100%;max-height:220px;object-fit:cover;border-radius:12px;border:1px solid #e5e7eb;display:block;" onerror="this.style.display=\'none\'">' +
        '</a>' +
        '<a href="https://maps.google.com/?q=' + lat + ',' + lng + '" target="_blank" rel="noopener noreferrer" ' +
           'style="display:inline-flex;align-items:center;gap:6px;margin-top:8px;background:#2563eb;color:#fff;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;text-decoration:none;">' +
          '&#128205; Google Haritada Ac' +
        '</a>' +
      '</div>'
    : '<div style="text-align:center;padding:24px 0;color:#9ca3af;"><span style="font-size:32px;">&#128205;</span><p style="margin-top:8px;font-size:13px;">Bu kayit icin konum paylasılmadı</p></div>';

  const historyHtml = (Array.isArray(row.statusHistory) && row.statusHistory.length)
    ? row.statusHistory.slice().reverse().map((h) =>
        '<div style="background:#f8fafc;border-radius:12px;padding:10px;border:1px solid #e2e8f0;margin-bottom:8px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
            '<span style="font-size:12px;font-weight:700;color:#334155;">' + escHtml(incidentStatusLabel(h.status)) + '</span>' +
            '<span style="font-size:11px;color:#94a3b8;">' + (h.at ? new Date(h.at).toLocaleString('tr-TR') : '-') + '</span>' +
          '</div>' +
          '<p style="font-size:12px;color:#475569;margin:0;">' + escHtml(h.note || 'Not yok') + '</p>' +
        '</div>'
      ).join('')
    : '<p style="font-size:12px;color:#9ca3af;">Durum gecmisi yok.</p>';

  const statusColors = {ALINDI:'#f39c12',INCELEMEDE:'#9b59b6',ISLEME_ALINDI:'#3498db',COZUMLENDI:'#2ecc71',KAPATILDI:'#e74c3c'};

  const modal = document.createElement('div');
  modal.id = 'incident-detail-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-start;justify-content:center;background:rgba(0,0,0,0.6);overflow-y:auto;padding:32px 16px;';
  modal.innerHTML =
    '<div style="background:#fff;border-radius:20px;box-shadow:0 25px 50px rgba(0,0,0,0.3);padding:24px;width:100%;max-width:700px;position:relative;">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">' +
        '<div>' +
          '<h3 style="font-weight:700;color:#111827;font-size:18px;margin:0;">' + escHtml(row.customerName || 'Bilinmiyor') + '</h3>' +
          '<p style="font-size:11px;color:#4f46e5;font-family:monospace;margin:4px 0 0;">#' + escHtml(row.incidentId || row.id || '') + '</p>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          '<span style="padding:4px 12px;border-radius:9999px;font-size:12px;font-weight:700;color:#fff;background:' + (statusColors[row.status] || '#6b7280') + ';">' + escHtml(incidentStatusLabel(row.status)) + '</span>' +
          '<button onclick="document.getElementById(\'incident-detail-modal\').remove()" style="font-size:24px;color:#9ca3af;background:none;border:none;cursor:pointer;line-height:1;padding:0 4px;">&times;</button>' +
        '</div>' +
      '</div>' +

      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px;">' +
        '<div style="background:#f8fafc;border-radius:12px;padding:12px;border:1px solid #e2e8f0;">' +
          '<p style="font-size:11px;color:#64748b;font-weight:600;margin:0 0 4px;">Telefon</p>' +
          '<p style="font-size:12px;color:#1e293b;font-family:monospace;margin:0;">' + escHtml(row.phone || row.customerPhone || '-') + '</p>' +
        '</div>' +
        '<div style="background:#f8fafc;border-radius:12px;padding:12px;border:1px solid #e2e8f0;">' +
          '<p style="font-size:11px;color:#64748b;font-weight:600;margin:0 0 4px;">Sayac / Tesisat</p>' +
          '<p style="font-size:12px;color:#1e293b;font-family:monospace;margin:0;">' + escHtml(row.meterNo || '-') + '</p>' +
        '</div>' +
        '<div style="background:#f8fafc;border-radius:12px;padding:12px;border:1px solid #e2e8f0;grid-column:span 2;">' +
          '<p style="font-size:11px;color:#64748b;font-weight:600;margin:0 0 4px;">Adres</p>' +
          '<p style="font-size:12px;color:#1e293b;margin:0;">' + escHtml(row.address || '-') + '</p>' +
        '</div>' +
        '<div style="background:#f8fafc;border-radius:12px;padding:12px;border:1px solid #e2e8f0;grid-column:span 2;">' +
          '<p style="font-size:11px;color:#64748b;font-weight:600;margin:0 0 4px;">Ariza / Talep</p>' +
          '<p style="font-size:12px;color:#1e293b;margin:0;">' + escHtml(row.issue || row.issueSummary || '-') + '</p>' +
        '</div>' +
      '</div>' +

      '<div style="margin-bottom:20px;">' +
        '<h4 style="font-weight:700;color:#1f2937;font-size:14px;margin:0 0 12px;">Musteri Fotograflari</h4>' +
        '<div style="display:flex;flex-wrap:wrap;gap:10px;">' + photosHtml + '</div>' +
      '</div>' +

      '<div style="margin-bottom:20px;">' +
        '<h4 style="font-weight:700;color:#1f2937;font-size:14px;margin:0 0 8px;">Musteri Konumu</h4>' +
        mapHtml +
      '</div>' +

      '<div>' +
        '<h4 style="font-weight:700;color:#1f2937;font-size:14px;margin:0 0 10px;">Durum Gecmisi</h4>' +
        historyHtml +
      '</div>' +
    '</div>';

  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}
window.openIncidentDetail = openIncidentDetail;
window.updateIncidentStatus = openIncidentStatusModal;
window.openIncidentStatusModal = openIncidentStatusModal;
window.closeIncidentStatusModal = closeIncidentStatusModal;
