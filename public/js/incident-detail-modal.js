// Arıza detay modalını açmak ve doldurmak için JS

window.openIncidentDetailModal = async function(incidentId) {
  const modal = document.getElementById('incident-detail-modal');
  const box = modal.querySelector('.modal-box');
  // Yükleniyor göster
  box.innerHTML = `<div class="text-center py-10 text-gray-400">Yükleniyor...</div>`;
  modal.classList.remove('hidden');
  try {
    const res = await apiFetch(`/crm/incidents/${encodeURIComponent(incidentId)}`);
    renderIncidentDetail(res);
  } catch (err) {
    box.innerHTML = `<div class="text-center py-10 text-red-500">Detay yüklenemedi</div>`;
  }
};

function renderIncidentDetail(incident) {
  const modal = document.getElementById('incident-detail-modal');
  const box = modal.querySelector('.modal-box');
  box.innerHTML = `
    <h2 class="text-lg font-bold text-gray-900 mb-4">Arıza Detayı</h2>
    <div class="mb-4">
      <div class="text-xs text-gray-500 mb-1">Kayıt No: ${incident.incidentId || ''}</div>
      <div class="text-xs text-gray-500 mb-1">Adres: ${incident.address || ''}</div>
      <div class="text-xs text-gray-500 mb-1">Durum: ${incident.statusLabel || ''}</div>
    </div>
    <div class="mb-6">
      <h3 class="font-semibold text-gray-800 mb-2 text-sm">Durum Güncellemeleri</h3>
      ${Array.isArray(incident.statusHistory) && incident.statusHistory.length > 0 ? `
        <ul class="space-y-3">
          ${incident.statusHistory.map(status => `
            <li class="bg-gray-50 border border-gray-100 rounded-xl p-3">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-xs font-semibold text-gray-700">${status.statusLabel || ''}</span>
                <span class="text-xs text-gray-400">${status.updatedAt ? new Date(status.updatedAt).toLocaleString('tr-TR') : ''}</span>
              </div>
              <div class="text-xs text-gray-700 mb-1">${status.note || ''}</div>
              ${Array.isArray(status.media) && status.media.length > 0 ? `
                <div class="flex flex-wrap gap-2 mt-2">
                  ${status.media.map(mediaUrl => mediaUrl.match(/\.(jpg|jpeg|png|gif|webp)$/i)
                    ? `<img src="${mediaUrl}" alt="Durum Fotoğrafı" class="max-h-32 rounded border border-gray-200">`
                    : mediaUrl.match(/\.(mp4)$/i)
                      ? `<video src="${mediaUrl}" controls class="max-h-32 rounded border border-gray-200"></video>`
                      : '').join('')}
                </div>
              ` : ''}
            </li>
          `).join('')}
        </ul>
      ` : `<div class="text-xs text-gray-400">Durum güncellemesi yok.</div>`}
    </div>
    <div>
      <h3 class="font-semibold text-gray-800 mb-2 text-sm">Müşteri / Teknisyen Fotoğrafları</h3>
      ${Array.isArray(incident.images) && incident.images.length > 0 ? `
        <div class="flex flex-wrap gap-2">
          ${incident.images.map(imgUrl => `<img src="${imgUrl}" alt="Arıza Fotoğrafı" class="max-h-32 rounded border border-gray-200">`).join('')}
        </div>
      ` : `<div class="text-xs text-gray-400">Yüklenmiş fotoğraf yok.</div>`}
    </div>
    <div class="flex justify-end gap-2 mt-6">
      <button type="button" onclick="closeIncidentDetailModal()" class="px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700">Kapat</button>
    </div>
  `;
}

window.closeIncidentDetailModal = function() {
  document.getElementById('incident-detail-modal').classList.add('hidden');
};
