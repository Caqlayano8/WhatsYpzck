// Tenant Management — Admin UI
// Handles CRUD for multi-tenant organizations

const TIER_LABELS = { free: 'Free', basic: 'Basic', pro: 'Pro', enterprise: 'Enterprise' };
const TIER_COLORS = { free: 'bg-gray-100 text-gray-600', basic: 'bg-blue-100 text-blue-700', pro: 'bg-indigo-100 text-indigo-700', enterprise: 'bg-purple-100 text-purple-700' };
const STATUS_COLORS = { active: 'bg-green-100 text-green-700', inactive: 'bg-gray-100 text-gray-500', suspended: 'bg-red-100 text-red-600' };
const STATUS_LABELS = { active: 'Aktif', inactive: 'Pasif', suspended: 'Askıya Alındı' };

function hasAdminRights() {
  const role = String(window.AdminState?.currentUser?.role || '').toLowerCase();
  // If auth/user info is still loading, do not block UI actions here.
  // Backend endpoints still enforce admin authorization strictly.
  if (!role) return true;
  return role === 'admin';
}

window.loadTenants = async function () {
  const tbody = document.getElementById('tenants-table-body');
  tbody.innerHTML = '<tr><td colspan="6" class="text-center py-10 text-gray-400"><i class="fas fa-circle-notch fa-spin mr-2"></i>Yükleniyor...</td></tr>';
  try {
    const tenants = await apiFetch('/crm/tenants', 'GET');
    if (!Array.isArray(tenants) || tenants.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center py-10 text-gray-400"><i class="fas fa-building text-3xl block mb-2 opacity-30"></i>Kayıtlı kiracı yok.</td></tr>';
      return;
    }
    tbody.innerHTML = tenants.map(t => `
      <tr class="border-b border-gray-50 hover:bg-gray-50 transition-colors">
        <td class="px-4 py-3 font-mono text-xs font-semibold text-gray-800">${t.code}</td>
        <td class="px-4 py-3">
          <div class="font-medium text-gray-900 text-sm">${t.name}</div>
          ${t.description ? `<div class="text-xs text-gray-400 mt-0.5">${t.description}</div>` : ''}
        </td>
        <td class="px-4 py-3 text-xs text-gray-600">${t.primaryPhone || '—'}</td>
        <td class="px-4 py-3"><span class="px-2 py-0.5 rounded-full text-xs font-semibold ${TIER_COLORS[t.tier] || 'bg-gray-100 text-gray-600'}">${TIER_LABELS[t.tier] || t.tier}</span></td>
        <td class="px-4 py-3"><span class="px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_COLORS[t.status] || 'bg-gray-100 text-gray-500'}">${STATUS_LABELS[t.status] || t.status}</span></td>
        <td class="px-4 py-3 text-right">
          <button onclick="editTenant('${t._id}')" data-tenant-id="${t._id}" class="text-xs text-indigo-600 hover:text-indigo-800 font-medium mr-3"><i class="fas fa-pen mr-1"></i>Düzenle</button>
          ${t.status !== 'inactive' ? `<button onclick="deactivateTenant('${t._id}', '${t.code}')" class="text-xs text-red-500 hover:text-red-700 font-medium"><i class="fas fa-ban mr-1"></i>Deaktif</button>` : ''}
        </td>
      </tr>
    `).join('');
    // Store for editTenant lookup
    window._tenantsList = tenants;
  } catch {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center py-10 text-red-400">Kiracılar yüklenemedi.</td></tr>';
  }
};

window.openTenantModal = function (tenant = null) {
  if (!hasAdminRights()) {
    showToast('Kiracı işlemleri için admin yetkisi gerekli', 'warning');
    return;
  }
  document.getElementById('tenant-modal-title').textContent = tenant ? 'Kiracı Düzenle' : 'Kiracı Ekle';
  document.getElementById('tenant-modal-id').value = tenant?._id || '';
  document.getElementById('tenant-code').value = tenant?.code || '';
  document.getElementById('tenant-code').readOnly = !!tenant;
  document.getElementById('tenant-code').classList.toggle('bg-gray-100', !!tenant);
  document.getElementById('tenant-code-note').classList.toggle('hidden', !tenant);
  document.getElementById('tenant-name').value = tenant?.name || '';
  document.getElementById('tenant-description').value = tenant?.description || '';
  document.getElementById('tenant-phone').value = tenant?.primaryPhone || '';
  document.getElementById('tenant-tier').value = tenant?.tier || 'free';
  document.getElementById('tenant-status').value = tenant?.status || 'active';
  document.getElementById('tenant-modal').classList.remove('hidden');
};

window.closeTenantModal = function () {
  document.getElementById('tenant-modal').classList.add('hidden');
};

window.saveTenant = async function () {
  if (!hasAdminRights()) {
    showToast('Kiracı işlemleri için admin yetkisi gerekli', 'warning');
    return;
  }
  const id = document.getElementById('tenant-modal-id').value;
  const code = document.getElementById('tenant-code').value.trim();
  const name = document.getElementById('tenant-name').value.trim();
  const description = document.getElementById('tenant-description').value.trim();
  const primaryPhone = document.getElementById('tenant-phone').value.trim();
  const tier = document.getElementById('tenant-tier').value;
  const status = document.getElementById('tenant-status').value;

  if (!name) { showToast('Ad zorunludur', 'warning'); return; }
  if (!id && !code) { showToast('Kod zorunludur', 'warning'); return; }

  try {
    if (id) {
      await apiFetch(`/crm/tenants/${id}`, 'PUT', { name, description, primaryPhone, tier, status });
      showToast('Kiracı güncellendi', 'success');
    } else {
      await apiFetch('/crm/tenants', 'POST', { code, name, description, primaryPhone, tier, status });
      showToast('Kiracı oluşturuldu', 'success');
    }
    closeTenantModal();
    loadTenants();
  } catch (e) {
    showToast(e.message || 'Kaydedilemedi', 'error');
  }
};

window.editTenant = function (id) {
  const tenant = (window._tenantsList || []).find(t => t._id === id);
  if (!tenant) return;
  openTenantModal(tenant);
};

window.deactivateTenant = async function (id, code) {
  if (!hasAdminRights()) {
    showToast('Kiracı işlemleri için admin yetkisi gerekli', 'warning');
    return;
  }
  if (!confirm(`'${code}' kiracısı deaktif edilsin mi?`)) return;
  try {
    await apiFetch(`/crm/tenants/${id}`, 'DELETE');
    showToast('Kiracı deaktif edildi', 'success');
    loadTenants();
  } catch {
    showToast('İşlem başarısız', 'error');
  }
};

// Fallback bindings: if inline onclick fails for any reason, these listeners
// keep tenant create/edit actions functional.
document.addEventListener('DOMContentLoaded', () => {
  const addBtn = document.getElementById('tenant-add-btn');
  if (addBtn && !addBtn.dataset.boundTenantAdd) {
    addBtn.addEventListener('click', () => window.openTenantModal());
    addBtn.dataset.boundTenantAdd = '1';
  }

  const saveBtn = document.getElementById('tenant-save-btn');
  if (saveBtn && !saveBtn.dataset.boundTenantSave) {
    saveBtn.addEventListener('click', () => window.saveTenant());
    saveBtn.dataset.boundTenantSave = '1';
  }

  const tbody = document.getElementById('tenants-table-body');
  if (tbody && !tbody.dataset.boundTenantTable) {
    tbody.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const editBtn = target.closest('button[data-tenant-id]');
      if (editBtn) {
        event.preventDefault();
        const tenantId = editBtn.getAttribute('data-tenant-id');
        if (tenantId) window.editTenant(tenantId);
      }
    });
    tbody.dataset.boundTenantTable = '1';
  }
});
