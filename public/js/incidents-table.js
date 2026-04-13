// Arıza kayıtlarını yükle ve tabloya yaz
async function loadIncidents() {
  try {
    const res = await apiFetch('/crm/incidents');
    const incidents = res.data || [];
    renderIncidentsTable(incidents);
  } catch (err) {
    document.getElementById('incidents-table-body').innerHTML = `<tr><td colspan="11" class="text-center text-red-500">Arıza kayıtları yüklenemedi</td></tr>`;
  }
}

function renderIncidentsTable(incidents) {
  const tbody = document.getElementById('incidents-table-body');
  if (!incidents.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="text-center text-gray-400">Kayıt bulunamadı</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  incidents.forEach(incident => {
    const tr = document.createElement('tr');
    tr.className = 'trow cursor-pointer hover:bg-gray-50';
    tr.onclick = () => openIncidentDetailModal(incident.incidentId);
    tr.innerHTML = `
      <td class="px-5 py-3 text-xs">${incident.incidentId || ''}</td>
      <td class="px-5 py-3 text-xs">${incident.createdAt ? new Date(incident.createdAt).toLocaleString('tr-TR') : ''}</td>
      <td class="px-5 py-3 text-xs">${incident.customerName || ''}</td>
      <td class="px-5 py-3 text-xs">${incident.customerPhone || ''}</td>
      <td class="px-5 py-3 text-xs">${incident.customerEmail || ''}</td>
      <td class="px-5 py-3 text-xs">${incident.address || ''}</td>
      <td class="px-5 py-3 text-xs">${incident.meterNo || ''}</td>
      <td class="px-5 py-3 text-xs">${incident.sourceNo || ''}</td>
      <td class="px-5 py-3 text-xs">${incident.statusLabel || ''}</td>
      <td class="px-5 py-3 text-xs">${(incident.images && incident.images.length) ? `<span class='text-green-600 font-bold'>${incident.images.length}</span>` : '-'}</td>
      <td class="px-5 py-3 text-xs"><button class="px-3 py-1 bg-indigo-600 text-white rounded text-xs" onclick="event.stopPropagation();openIncidentStatusModal('${incident.incidentId}')">Durum Güncelle</button></td>
    `;
    tbody.appendChild(tr);
  });
}

window.loadIncidents = loadIncidents;
window.renderIncidentsTable = renderIncidentsTable;
