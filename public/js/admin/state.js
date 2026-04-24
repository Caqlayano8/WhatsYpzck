// Shared mutable state
// All admin modules read/write through this single object so state
// remains consistent across files without a bundler.
window.AdminState = {
  currentUser:              null,
  currentRecipient:         null,
  currentContactId:         null,
  currentTags:              [],
  currentTemplateId:        null,
  currentUserId:            null,
  currentDeliveryCampaignId:null,
  contactsPage:             1,
  contactsSearch:           '',
  contactViewMode:          'all',
  templates:                [],
  allContacts:              [],
  campaigns:                [],
  users:                    [],
  currentCampaignTab:       'compose',
  autoDownloadEnabled:      true,
  logEventSource:           null,
  logFilter:                'all',
  logEntries:               [],
  analyticsCharts:          {},
  auditPage:                1,
  qrInstance:               null,
  currentInboxPhone:        null,
  inboxEventSource:         null,
  scoreRules:               [],
  inboxConversations:       [],
  integrations:             [],
  autoReplies:              [],
  currentIntegrationId:     null,
  currentAutoReplyId:       null,
  currentIntegrationTab:    'webhooks',
  availableEvents:          [],
  chatsSearchTimer:         null,
  chatsSearchMode:          false,
  commandPrefix:            '/',
  recapGroups:              [],
  contactGroups:            [],
  editingContactGroupId:    null,
  incidents:                [],
  incidentSearch:           '',
  sessionsLoaded:           false,
  sessions:                 [],
  sessionQrInstance:        null,
  maskPhoneNumbers:         true,
  maskContactNames:         true,
};

// Central API helper
async function apiFetch(url, method = 'GET', body = null) {
  const token = localStorage.getItem('token');
  const opts = {
    method,
    headers: {
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  const res = await fetch(url, opts);

  const parseBody = async () => {
    if (res.status === 204) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/json')) {
      try { return await res.json(); } catch (_) { return null; }
    }
    try {
      const txt = await res.text();
      if (!txt) return null;
      try { return JSON.parse(txt); } catch (_) { return txt; }
    } catch (_) {
      return null;
    }
  };

  const parsed = await parseBody();

  if (!res.ok) {
    let errMsg = `${method} ${url} -> ${res.status}`;
    if (parsed && typeof parsed === 'object') {
      if (parsed.error) errMsg = parsed.error;
      else if (parsed.message) errMsg = parsed.message;
    } else if (typeof parsed === 'string' && parsed.trim()) {
      errMsg = parsed.trim();
    }

    if (res.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/admin/login';
    }

    if (res.status === 403 && typeof window.showToast === 'function') {
      window.showToast(errMsg || 'Bu işlem için yetkiniz yok', 'warning');
    }

    throw new Error(errMsg);
  }

  return parsed;
}
