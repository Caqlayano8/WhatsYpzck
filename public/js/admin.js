document.addEventListener('DOMContentLoaded', function () {

  function safeRun(fn, label) {
    try {
      if (typeof fn === 'function') fn();
    } catch (err) {
      console.error('[admin] init error at ' + label, err);
    }
  }

  // Boot
  safeRun(checkAuth, 'checkAuth');
  safeRun(initSidebarToggle, 'initSidebarToggle');
  safeRun(initTabSwitching, 'initTabSwitching');
  safeRun(initSearchHandlers, 'initSearchHandlers');
  safeRun(initFormHandlers, 'initFormHandlers');
  safeRun(() => {
    if (typeof loadContacts === 'function') loadContacts();
  }, 'loadContacts');

  // Auth
  async function checkAuth() {
    const token = localStorage.getItem('token');
    if (!token) return redirect('/admin/login');
    try {
      const res = await apiFetch('/crm/auth/check');
      window.AdminState.currentUser = res.user;
      document.getElementById('username').textContent = res.user.username;
    } catch {
      localStorage.removeItem('token');
      redirect('/admin/login');
    }
  }

  const logoutBtn = document.getElementById('logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      stopLogStream();
      stopInboxStream();
      localStorage.removeItem('token');
      redirect('/admin/login');
    });
  }

  // Sidebar Toggle
  function initSidebarToggle() {
    if (localStorage.getItem('sidebarCollapsed') === 'true') {
      document.body.classList.add('sidebar-collapsed');
    }
    const sidebarToggle = document.getElementById('sidebar-toggle');
    if (!sidebarToggle) return;
    sidebarToggle.addEventListener('click', () => {
      const collapsed = document.body.classList.toggle('sidebar-collapsed');
      localStorage.setItem('sidebarCollapsed', collapsed);
    });
  }

  // Tab Switching
  function initTabSwitching() {
    const runTabLoader = (name, ...args) => {
      const fromWindow = window[name];
      if (typeof fromWindow === 'function') return fromWindow(...args);
      const fromScope = globalThis[name];
      if (typeof fromScope === 'function') return fromScope(...args);
      console.warn('[admin] loader not found:', name);
      return undefined;
    };

    const tabMap = {
      'dashboard-tab':          { section: 'dashboard-section',          onLoad: () => runTabLoader('loadDashboardData') },
      'contacts-tab':           { section: 'contacts-section',           onLoad: () => runTabLoader('loadContacts') },
      'analytics-tab':          { section: 'analytics-section',          onLoad: () => runTabLoader('loadAnalytics') },
      'campaigns-tab':          { section: 'campaigns-section',          onLoad: () => runTabLoader('loadCampaigns') },
      'templates-tab':          { section: 'templates-section',          onLoad: () => runTabLoader('loadTemplates') },
      'bot-tab':                { section: 'bot-section',                onLoad: () => { runTabLoader('loadSessions'); runTabLoader('loadBotStatus'); runTabLoader('startLogStream'); } },
      'commands-tab':           { section: 'commands-section',           onLoad: () => runTabLoader('loadCommands') },
      'users-tab':              { section: 'users-section',              onLoad: () => runTabLoader('loadUsers') },
      'tenants-tab':            { section: 'tenants-section',            onLoad: () => runTabLoader('loadTenants') },
      'incidents-tab':          { section: 'incidents-section',          onLoad: () => runTabLoader('loadIncidents') },
      'audit-tab':              { section: 'audit-section',              onLoad: () => runTabLoader('loadAuditLogs', 1) },
      'settings-tab':           { section: 'settings-section',           onLoad: () => runTabLoader('loadSettings') },
      'chats-tab':              { section: 'chats-section',              onLoad: () => runTabLoader('loadChats') },
      'scoring-tab':            { section: 'scoring-section',            onLoad: () => runTabLoader('loadScoring') },
      'survey-tab':             { section: 'survey-section',             onLoad: () => runTabLoader('loadSurveys') },
      'scheduled-messages-tab': { section: 'scheduled-messages-section', onLoad: () => runTabLoader('loadScheduledMessages') },
      'widget-tab':             { section: 'widget-section',             onLoad: () => runTabLoader('loadWidgetSettings') },
      'flows-tab':              { section: 'flows-section',              onLoad: () => runTabLoader('loadFlows') },
      'integrations-tab':       { section: 'integrations-section',       onLoad: () => runTabLoader('loadIntegrations') },
      'groups-tab':             { section: 'groups-section',             onLoad: () => runTabLoader('loadGroups') },
    };

    function openTab(tabId) {
      const conf = tabMap[tabId];
      if (!conf) return false;

      if (tabId !== 'bot-tab') stopLogStream();

      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      const item = document.getElementById(tabId);
      if (item) item.classList.add('active');

      document.querySelectorAll('.section-content').forEach(s => {
        s.classList.add('hidden');
        s.style.removeProperty('display');
      });
      const sectionEl = document.getElementById(conf.section);
      if (!sectionEl) {
        console.error('[admin] section not found:', conf.section);
        return false;
      }
      sectionEl.classList.remove('hidden');
      if (conf.section === 'chats-section') sectionEl.style.display = 'flex';

      try {
        if (conf.onLoad) conf.onLoad();
      } catch (err) {
        console.error('[admin] onLoad failed for tab ' + tabId, err);
        return false;
      }

      const tabKey = tabId.replace(/-tab$/, '');
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', '/admin?tab=' + encodeURIComponent(tabKey));
      }

      return true;
    }

    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', e => {
        if (!tabMap[item.id]) return;
        const ok = openTab(item.id);
        // If SPA tab switch failed for any reason, let normal anchor navigation continue.
        if (ok) e.preventDefault();
      });
    });

    const params = new URLSearchParams(window.location.search);
    const requestedTab = (params.get('tab') || '').trim();
    if (requestedTab) {
      const requestedTabId = requestedTab + '-tab';
      if (tabMap[requestedTabId]) {
        openTab(requestedTabId);
      }
    }
  }

  // Search handlers
  function initSearchHandlers() {
    const AS = window.AdminState;

    document.getElementById('contact-search')?.addEventListener('input', function () {
      AS.contactsSearch = this.value;
      loadContacts(1);
    });

    document.getElementById('template-search')?.addEventListener('input', function () {
      const q = this.value.toLowerCase();
      const cat = document.getElementById('template-category-filter')?.value || '';
      const filtered = AS.templates.filter(t =>
        (!cat || t.category === cat) &&
        (t.name.toLowerCase().includes(q) || t.content.toLowerCase().includes(q))
      );
      renderTemplates(filtered);
    });

    document.getElementById('incident-search')?.addEventListener('input', function () {
      window.AdminState.incidentSearch = this.value || '';
      loadIncidents();
    });
  }

  function initFormHandlers() {
    document.getElementById('settings-form')?.addEventListener('submit', e => {
      e.preventDefault();
      saveSettings();
    });
  }

});
