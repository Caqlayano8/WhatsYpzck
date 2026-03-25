// Maintenance Mode Management

let maintenanceModeEnabled = false;

async function loadMaintenanceStatus() {
  try {
    const data = await apiFetch('/crm/settings/maintenance');
    maintenanceModeEnabled = data.enabled || false;

    updateMaintenanceToggleUI(maintenanceModeEnabled);

    const badge = document.getElementById('maintenance-status-badge');
    if (badge) {
      badge.textContent = maintenanceModeEnabled ? 'Bakımda' : 'Normal';
      badge.className = `text-xs font-bold px-2.5 py-1 rounded-full ${maintenanceModeEnabled ? 'bg-orange-100 text-orange-700' : 'bg-green-100 text-green-700'}`;
    }

    const msgEl = document.getElementById('maintenance-message');
    const endsAtEl = document.getElementById('maintenance-ends-at');
    if (msgEl) msgEl.value = data.message || '';
    if (endsAtEl && data.endsAt) {
      const d = new Date(data.endsAt);
      endsAtEl.value = d.toISOString().slice(0, 16);
    }
  } catch (_) {
    // non-critical
  }
}

function updateMaintenanceToggleUI(enabled) {
  const track = document.getElementById('maintenance-toggle-track');
  const thumb = document.getElementById('maintenance-toggle-thumb');
  if (!track || !thumb) return;
  if (enabled) {
    track.className = 'w-11 h-6 rounded-full transition-colors duration-200 bg-orange-500';
    thumb.style.transform = 'translateX(20px)';
  } else {
    track.className = 'w-11 h-6 rounded-full transition-colors duration-200 bg-gray-200';
    thumb.style.transform = 'translateX(0px)';
  }
}

window.toggleMaintenanceSwitch = function () {
  maintenanceModeEnabled = !maintenanceModeEnabled;
  updateMaintenanceToggleUI(maintenanceModeEnabled);
};

window.saveMaintenanceSettings = async function () {
  const message = document.getElementById('maintenance-message')?.value?.trim() || '';
  const endsAtVal = document.getElementById('maintenance-ends-at')?.value || '';
  const endsAt = endsAtVal ? new Date(endsAtVal).toISOString() : null;

  try {
    await apiFetch('/crm/settings/maintenance', 'POST', {
      enabled: maintenanceModeEnabled,
      message,
      endsAt,
    });
    showToast(
      maintenanceModeEnabled ? 'Bakım modu etkinleştirildi' : 'Bakım modu devre dışı bırakıldı',
      'success'
    );
    loadMaintenanceStatus();
  } catch (_) {
    showToast('Bakım ayarları kaydedilemedi', 'error');
  }
};

async function loadMaintenanceMessages() {
  const container = document.getElementById('maintenance-messages-list');
  if (!container) return;

  try {
    const data = await apiFetch('/crm/messages/maintenance');
    if (!data || !data.length) {
      container.innerHTML =
        '<div class="text-sm text-gray-400 text-center py-4">Bakım sırasında alınan mesaj yok</div>';
      return;
    }

    container.innerHTML = data
      .map(
        (msg) => `
      <div class="flex items-start gap-3 py-3 border-b border-gray-100 last:border-0">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-sm font-semibold text-gray-800">${escHtml(msg.senderName || msg.phoneNumber)}</span>
            <span class="text-xs text-gray-400">${fmtDate(msg.timestamp)}</span>
          </div>
          <div class="text-sm text-gray-600 truncate">${escHtml(msg.body)}</div>
          <div class="text-xs text-gray-400 mt-0.5">${escHtml(msg.phoneNumber)}</div>
        </div>
        <button onclick="openChatWithPhone('${escHtml(msg.phoneNumber)}')"
          class="flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg border border-indigo-200 text-indigo-600 hover:bg-indigo-50 transition-colors">
          <i class="fas fa-reply mr-1"></i> Yanıtla
        </button>
      </div>`
      )
      .join('');
  } catch (_) {
    container.innerHTML =
      '<div class="text-sm text-red-400 text-center py-4">Mesajlar yüklenemedi</div>';
  }
}

function openChatWithPhone(phone) {
  if (typeof window.showSection === 'function') {
    window.showSection('chats');
  }
  const searchEl = document.getElementById('chat-search');
  if (searchEl) {
    searchEl.value = phone;
    searchEl.dispatchEvent(new Event('input'));
  }
}

// Auto-load when settings section becomes visible
document.addEventListener('DOMContentLoaded', function () {
  const settingsSection = document.getElementById('settings-section');
  if (!settingsSection) return;

  const observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
        const el = mutation.target;
        if (!el.classList.contains('hidden')) {
          loadMaintenanceStatus();
          loadMaintenanceMessages();
        }
      }
    });
  });

  observer.observe(settingsSection, { attributes: true });
});
