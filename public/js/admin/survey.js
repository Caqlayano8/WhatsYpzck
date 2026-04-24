// Anket Sonuçları

async function loadSurveys(page = 1) {
  try {
    const phone    = (document.getElementById('survey-filter-phone')?.value || '').trim();
    const incident = (document.getElementById('survey-filter-incident')?.value || '').trim();
    let url = `/crm/surveys?page=${page}&limit=20`;
    if (phone)    url += `&customerPhone=${encodeURIComponent(phone)}`;
    if (incident) url += `&incidentId=${encodeURIComponent(incident)}`;

    const [data, settings] = await Promise.all([
      apiFetch(url),
      apiFetch('/crm/settings/survey'),
    ]);

    // İstatistikler
    document.getElementById('survey-stat-total').textContent     = data.stats?.total     ?? '0';
    document.getElementById('survey-stat-completed').textContent = data.stats?.completed  ?? '0';
    document.getElementById('survey-stat-solution').textContent  = data.stats?.solutionOk ?? '0';
    document.getElementById('survey-stat-tech').textContent      = data.stats?.techOk     ?? '0';

    // Tablo
    renderSurveyResponses(data.data || []);

    // Pagination
    renderSurveyPagination(data.meta, page);

    // Ayarlar
    const surveyEnabled = !!settings.enabled;
    const surveyCheckbox = document.getElementById('survey-enabled');
    const surveyBtn = document.getElementById('survey-enabled-btn');
    if (surveyCheckbox) surveyCheckbox.checked = surveyEnabled;
    if (surveyBtn) {
      surveyBtn.style.backgroundColor = surveyEnabled ? '#4f46e5' : '#d1d5db';
      const dot = surveyBtn.querySelector('span');
      if (dot) dot.style.transform = surveyEnabled ? 'translateX(20px)' : 'translateX(2px)';
    }
    document.getElementById('survey-message').value   = settings.message || '';
    document.getElementById('survey-thanks').value    = settings.thankYouMessage || '';
  } catch {
    showToast('Anket verileri yüklenemedi', 'error');
  }
}

function renderSurveyPagination(meta, current) {
  const el = document.getElementById('survey-pagination');
  if (!el || !meta || meta.pages <= 1) { if(el) el.innerHTML=''; return; }
  let html = '';
  for (let i = 1; i <= meta.pages; i++) {
    const active = i === current ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200';
    html += `<button onclick="loadSurveys(${i})" class="px-3 py-1 rounded-lg text-xs font-semibold ${active}">${i}</button>`;
  }
  el.innerHTML = html;
}

function renderSurveyResponses(list) {
  const tbody = document.getElementById('survey-responses-body');
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center text-sm text-gray-400">Henüz anket yanıtı yok</td></tr>`;
    return;
  }
  const yn = v => v === true  ? '<span class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-semibold">✅ Evet</span>'
                : v === false ? '<span class="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-semibold">❌ Hayır</span>'
                : '<span class="text-xs text-gray-300">—</span>';
  const statusBadge = s => {
    if (s === 'completed') return '<span class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-semibold">Tamamlandı</span>';
    if (s === 'expired')   return '<span class="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-semibold">Süresi Doldu</span>';
    return '<span class="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-semibold">Bekliyor</span>';
  };
  tbody.innerHTML = list.map(r => `
    <tr class="trow border-b border-gray-50">
      <td class="px-4 py-2.5 text-sm font-mono text-gray-700">${escHtml(String(r.incidentId || '—'))}</td>
      <td class="px-4 py-2.5 text-sm text-gray-700">
        <div class="font-medium">${escHtml(maskName(r.customerName) || '—')}</div>
        <div class="text-xs text-gray-400 font-mono">${escHtml(maskPhone(r.customerPhone) || '')}</div>
      </td>
      <td class="px-4 py-2.5">${yn(r.solutionSatisfied)}</td>
      <td class="px-4 py-2.5">${yn(r.techSatisfied)}</td>
      <td class="px-4 py-2.5 text-xs text-gray-600 max-w-xs" style="max-width:160px;white-space:normal">${r.freeComment ? escHtml(r.freeComment) : '<span class="text-gray-300">—</span>'}</td>
      <td class="px-4 py-2.5">${statusBadge(r.status)}</td>
      <td class="px-4 py-2.5 text-xs text-gray-400">${r.sentAt ? new Date(r.sentAt).toLocaleString('tr-TR') : '—'}</td>
    </tr>
  `).join('');
}

window.saveSurveySettings = async function () {
  const enabled         = document.getElementById('survey-enabled').checked;
  const message         = document.getElementById('survey-message').value.trim();
  const thankYouMessage = document.getElementById('survey-thanks').value.trim();
  try {
    await apiFetch('/crm/settings/survey', 'POST', { enabled, message, thankYouMessage });
    showToast('Anket ayarları kaydedildi', 'success');
  } catch {
    showToast('Anket ayarları kaydedilemedi', 'error');
  }
};
