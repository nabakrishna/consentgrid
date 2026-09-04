// public/app.js — ConsentGrid dashboard + public pages. Vanilla JS, no build step.
// Dashboard requests authenticate via the cg_session cookie (set on login, or
// set here after signup). API keys are never needed for dashboard endpoints.
(function () {
  'use strict';

  // ── tiny helpers ──────────────────────────────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let toastTimer = null;
  function toast(msg, kind) {
    const t = $('#toast'); if (!t) return;
    t.textContent = msg; t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 3800);
  }

  async function api(method, path, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(path, opts);
    let json = {};
    try { json = await res.json(); } catch { /* non-JSON (e.g. export) */ }
    if (!res.ok) {
      const err = new Error(json.message || json.error || ('HTTP ' + res.status));
      err.status = res.status; err.body = json;
      throw err;
    }
    return json;
  }

  const EIGHTH = ['as','bn','brx','doi','gu','hi','kn','ks','kok','mai','ml','mni','mr','ne','or','pa','sa','sat','sd','ta','te','ur','en'];

  // ── Auth page (index.html) ──────────────────────────────────────────────────
  function initAuthPage() {
    const loginForm = $('#login-form'), signupForm = $('#signup-form');
    const tabLogin = $('#tab-login'), tabSignup = $('#tab-signup');
    tabLogin.onclick = () => { tabLogin.classList.add('active'); tabSignup.classList.remove('active'); loginForm.classList.remove('hidden'); signupForm.classList.add('hidden'); };
    tabSignup.onclick = () => { tabSignup.classList.add('active'); tabLogin.classList.remove('active'); signupForm.classList.remove('hidden'); loginForm.classList.add('hidden'); };

    loginForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/v1/sessions', { email: $('#login-email').value, password: $('#login-password').value });
        // server set the HttpOnly cookie; go to dashboard.
        location.href = '/dashboard';
      } catch (err) { toast(err.message, 'err'); }
    };

    signupForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/v1/orgs', { name: $('#signup-name').value, email: $('#signup-email').value, password: $('#signup-password').value });
        // signup returns a session token but does not set the cookie — set it here (non-HttpOnly, same-origin).
        document.cookie = 'cg_session=' + encodeURIComponent(r.session) + '; path=/; SameSite=Lax; Max-Age=28800';
        // Show the one-time API key before proceeding.
        signupForm.innerHTML =
          '<h3 style="font-size:15px;margin:0 0 6px">Organization created</h3>' +
          '<p class="hint">Store this API key now — it will not be shown again. Keep it server-side; never ship it in client code.</p>' +
          '<div class="secret-box">' + esc(r.api_key) + '</div>' +
          '<div class="spacer"></div><button class="btn" id="go-dash" style="width:100%">Continue to dashboard</button>';
        $('#go-dash').onclick = () => (location.href = '/dashboard');
      } catch (err) { toast(err.message, 'err'); }
    };
  }

  // ── Dashboard (dashboard.html) ────────────────────────────────────────────────
  function initDashboard() {
    // nav view switching
    $$('.topbar nav a[data-view]').forEach((a) => {
      a.onclick = (e) => { e.preventDefault(); showView(a.getAttribute('data-view')); $$('.topbar nav a').forEach((x) => x.classList.remove('active')); a.classList.add('active'); };
    });
    $('#signout').onclick = (e) => { e.preventDefault(); document.cookie = 'cg_session=; path=/; Max-Age=0'; location.href = '/'; };

    // populate locale dropdown
    const locSel = $('#loc-locale');
    if (locSel) EIGHTH.forEach((c) => locSel.appendChild(new Option(c, c)));

    wireNotices();
    wireLog();
    wireKeys();
    wireWebhooks();
    wireIntegrity();

    // initial load — verify session by loading templates; bounce to login on 401
    loadTemplates().catch((err) => { if (err.status === 401) location.href = '/'; });
    loadKeys().catch(() => {});
    showView('notices');
  }

  function showView(name) {
    $$('section[data-panel]').forEach((s) => s.classList.toggle('hidden', s.getAttribute('data-panel') !== name));
    if (name === 'log') loadLog();
    if (name === 'keys') loadKeys();
    if (name === 'webhooks') { loadWebhooks(); loadDlq(); }
  }

  // Notices ------------------------------------------------------------------
  let TEMPLATES = [];
  function wireNotices() {
    $('#tpl-form').onsubmit = async (e) => {
      e.preventDefault();
      const purposes = $('#tpl-purposes').value.split(',').map((s) => s.trim()).filter(Boolean);
      try {
        await api('POST', '/v1/templates', { name: $('#tpl-name').value, purposes });
        toast('Template created', 'ok'); $('#tpl-form').reset(); await loadTemplates();
      } catch (err) { toast(err.message, 'err'); }
    };
    $('#ver-form').onsubmit = async (e) => {
      e.preventDefault();
      const tid = $('#ver-template').value;
      let payload = {};
      const raw = $('#ver-payload').value.trim();
      if (raw) { try { payload = JSON.parse(raw); } catch { return toast('Variable payload is not valid JSON', 'err'); } }
      try {
        await api('POST', '/v1/templates/' + tid + '/versions', { template_boilerplate: $('#ver-boilerplate').value, variable_payload: payload });
        toast('Version created', 'ok'); $('#ver-boilerplate').value = ''; $('#ver-payload').value = '';
        await loadVersions(tid);
      } catch (err) { toast(err.message, 'err'); }
    };
    $('#ver-template').onchange = () => loadVersions($('#ver-template').value);
    $('#loc-version').onchange = () => loadLocales($('#loc-version').value);
    $('#loc-form').onsubmit = async (e) => {
      e.preventDefault();
      const vid = $('#loc-version').value;
      try {
        await api('POST', '/v1/versions/' + vid + '/locales', {
          locale: $('#loc-locale').value, title: $('#loc-title').value, body_html: $('#loc-body').value, auto_translated: $('#loc-auto').checked,
        });
        toast('Locale added (draft)', 'ok'); $('#loc-title').value = ''; $('#loc-body').value = ''; $('#loc-auto').checked = false;
        await loadLocales(vid);
      } catch (err) { toast(err.message, 'err'); }
    };
  }

  async function loadTemplates() {
    const { templates } = await api('GET', '/v1/templates');
    TEMPLATES = templates || [];
    const verSel = $('#ver-template');
    verSel.innerHTML = '';
    TEMPLATES.forEach((t) => verSel.appendChild(new Option(t.name + ' (' + (t.purposes || []).join(', ') + ')', t.template_id)));
    if (TEMPLATES.length) await loadVersions(TEMPLATES[0].template_id);
  }

  async function loadVersions(templateId) {
    if (!templateId) return;
    const { versions } = await api('GET', '/v1/templates/' + templateId + '/versions');
    const sel = $('#loc-version');
    sel.innerHTML = '';
    (versions || []).forEach((v) => sel.appendChild(new Option('v' + v.version_num + ' · ' + v.notice_version_hash.slice(0, 10) + (v.locked ? ' · locked' : ''), v.version_id)));
    if (versions && versions.length) await loadLocales(versions[0].version_id);
    else $('#loc-table').querySelector('tbody').innerHTML = '';
  }

  async function loadLocales(versionId) {
    if (!versionId) return;
    const { locales } = await api('GET', '/v1/versions/' + versionId + '/locales');
    const tb = $('#loc-table').querySelector('tbody');
    tb.innerHTML = '';
    (locales || []).forEach((l) => {
      const tr = document.createElement('tr');
      const approved = l.legal_review_state === 'approved';
      tr.innerHTML =
        '<td class="mono">' + esc(l.locale) + '</td>' +
        '<td>' + esc(l.title) + '</td>' +
        '<td>' + esc(l.direction) + '</td>' +
        '<td><span class="pill ' + (approved ? 'ok' : 'warn') + '">' + esc(l.legal_review_state) + '</span></td>' +
        '<td>' + (l.auto_translated ? '<span class="pill neutral">auto</span>' : '—') + '</td>' +
        '<td></td>';
      if (!approved) {
        const btn = document.createElement('button'); btn.className = 'btn btn-sm'; btn.textContent = 'Approve';
        btn.onclick = async () => {
          try { await api('POST', '/v1/versions/' + versionId + '/locales/' + l.locale + '/approve'); toast('Approved — consent now recordable in ' + l.locale, 'ok'); await loadLocales(versionId); }
          catch (err) { toast(err.message, 'err'); }
        };
        tr.lastChild.appendChild(btn);
      }
      tb.appendChild(tr);
    });
  }

  // Consent log --------------------------------------------------------------
  function wireLog() {
    $('#log-refresh').onclick = loadLog;
    $('#export-json').onclick = () => downloadExport('json');
    $('#export-csv').onclick = () => downloadExport('csv');
  }
  async function loadLog() {
    const params = new URLSearchParams();
    if ($('#log-action').value) params.set('action', $('#log-action').value);
    if ($('#log-locale').value) params.set('locale', $('#log-locale').value.trim());
    params.set('limit', $('#log-limit').value || '100');
    try {
      const { artifacts } = await api('GET', '/v1/consent-log?' + params.toString());
      const tb = $('#log-table').querySelector('tbody'); tb.innerHTML = '';
      (artifacts || []).forEach((a) => {
        const purposes = a.purposes && typeof a.purposes === 'object'
          ? Object.entries(a.purposes).map(([k, v]) => k + (v ? '✓' : '✗')).join(' ') : '';
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="mono">' + esc((a.created_at || '').replace('T', ' ').slice(0, 19)) + '</td>' +
          '<td><span class="pill neutral">' + esc(a.action) + '</span></td>' +
          '<td class="mono">' + esc(a.locale) + '</td>' +
          '<td>' + esc(purposes) + '</td>' +
          '<td>' + (a.is_minor ? '<span class="pill warn">minor</span>' : '—') + '</td>' +
          '<td class="mono">' + esc((a.artifact_id || '').slice(0, 12)) + '…</td>' +
          '<td></td>';
        const btn = document.createElement('button'); btn.className = 'btn btn-sm btn-ghost'; btn.textContent = 'Verify';
        btn.onclick = () => verifyArtifactInline(a.artifact_id, tr);
        tr.lastChild.appendChild(btn);
        tb.appendChild(tr);
      });
      if (!artifacts || !artifacts.length) tb.innerHTML = '<tr><td colspan="7" class="hint">No artifacts yet.</td></tr>';
    } catch (err) { toast(err.message, 'err'); }
  }
  async function verifyArtifactInline(id, tr) {
    try {
      const r = await api('GET', '/v1/verify/' + id);
      const ok = r.signature_valid && r.content_hash_intact;
      toast('Artifact ' + id.slice(0, 8) + '… ' + (ok ? 'verified ✓' : 'FAILED verification'), ok ? 'ok' : 'err');
    } catch (err) { toast(err.message, 'err'); }
  }
  function downloadExport(format) {
    // Export streams a file; use a plain navigation with the session cookie.
    const a = document.createElement('a');
    a.href = '/v1/export?format=' + format; a.download = 'consent-export.' + format;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // API keys -----------------------------------------------------------------
  function wireKeys() {
    $('#key-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/v1/api-keys', { label: $('#key-label').value || 'key' });
        $('#key-reveal').innerHTML = '<p class="hint" style="margin-top:12px">New key (shown once):</p><div class="secret-box">' + esc(r.api_key) + '</div>';
        $('#key-label').value = ''; await loadKeys();
      } catch (err) { toast(err.message, 'err'); }
    };
  }
  async function loadKeys() {
    const { keys } = await api('GET', '/v1/api-keys');
    const tb = $('#key-table').querySelector('tbody'); tb.innerHTML = '';
    (keys || []).forEach((k) => {
      const revoked = !!k.revoked_at;
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + esc(k.label) + '</td>' +
        '<td class="mono">' + esc(k.key_prefix) + '…</td>' +
        '<td>' + esc(k.scope) + '</td>' +
        '<td class="mono">' + esc((k.created_at || '').slice(0, 10)) + '</td>' +
        '<td>' + (revoked ? '<span class="pill err">revoked</span>' : '<span class="pill ok">active</span>') + '</td>' +
        '<td></td>';
      if (!revoked) {
        const btn = document.createElement('button'); btn.className = 'btn btn-sm btn-danger'; btn.textContent = 'Revoke';
        btn.onclick = async () => { try { await api('DELETE', '/v1/api-keys/' + k.key_id); toast('Key revoked', 'ok'); await loadKeys(); } catch (err) { toast(err.message, 'err'); } };
        tr.lastChild.appendChild(btn);
      }
      tb.appendChild(tr);
    });
  }

  // Webhooks -----------------------------------------------------------------
  function wireWebhooks() {
    $('#wh-form').onsubmit = async (e) => {
      e.preventDefault();
      const events = $('#wh-events').value.split(',').map((s) => s.trim()).filter(Boolean);
      try {
        const r = await api('POST', '/v1/webhooks', { url: $('#wh-url').value, events: events.length ? events : undefined });
        $('#wh-reveal').innerHTML = '<p class="hint" style="margin-top:12px">Signing secret (shown once) — verify the <code>CG-Signature</code> header with it:</p><div class="secret-box">' + esc(r.secret) + '</div>';
        $('#wh-url').value = ''; $('#wh-events').value = ''; await loadWebhooks();
      } catch (err) { toast(err.message, 'err'); }
    };
  }
  async function loadWebhooks() {
    const { endpoints } = await api('GET', '/v1/webhooks');
    const tb = $('#wh-table').querySelector('tbody'); tb.innerHTML = '';
    (endpoints || []).forEach((e) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td class="mono">' + esc(e.url) + '</td><td>' + esc((e.events || []).join(', ') || 'all') + '</td><td>' + (e.active ? '<span class="pill ok">yes</span>' : '<span class="pill neutral">no</span>') + '</td>';
      tb.appendChild(tr);
    });
    if (!endpoints || !endpoints.length) tb.innerHTML = '<tr><td colspan="3" class="hint">No endpoints.</td></tr>';
  }
  async function loadDlq() {
    const { dead_letters } = await api('GET', '/v1/webhooks/dead-letters');
    const tb = $('#dlq-table').querySelector('tbody'); tb.innerHTML = '';
    (dead_letters || []).forEach((d) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(d.event_type) + '</td><td>' + esc(d.attempts) + '</td><td class="mono">' + esc((d.last_error || '').slice(0, 60)) + '</td><td class="mono">' + esc((d.created_at || '').slice(0, 19)) + '</td>';
      tb.appendChild(tr);
    });
    if (!dead_letters || !dead_letters.length) tb.innerHTML = '<tr><td colspan="4" class="hint">Dead-letter queue is empty.</td></tr>';
  }

  // Integrity ----------------------------------------------------------------
  function wireIntegrity() {
    $('#chain-verify').onclick = async () => {
      $('#chain-result').innerHTML = '<p class="hint">Verifying…</p>';
      try {
        const r = await api('GET', '/v1/chain/verify');
        const ok = r.ok || r.valid;
        $('#chain-result').innerHTML =
          '<p class="' + (ok ? 'result-good' : 'result-bad') + '">' + (ok ? '✓ Chain intact' : '✗ Chain verification failed') + '</p>' +
          '<div class="kv">' +
          '<dt>Artifacts checked</dt><dd>' + esc(r.count != null ? r.count : '—') + '</dd>' +
          (r.brokenAt != null ? '<dt>Broken at index</dt><dd>' + esc(r.brokenAt) + '</dd>' : '') +
          (r.reason ? '<dt>Reason</dt><dd>' + esc(r.reason) + '</dd>' : '') +
          '</div>' +
          '<pre style="margin-top:12px">' + esc(JSON.stringify(r, null, 2)) + '</pre>';
      } catch (err) { $('#chain-result').innerHTML = '<p class="result-bad">' + esc(err.message) + '</p>'; }
    };
  }

  // ── Public verify page (verify.html) ────────────────────────────────────────
  function initVerifyPage() {
    $('#verify-form').onsubmit = async (e) => {
      e.preventDefault();
      const id = $('#verify-id').value.trim();
      $('#verify-result').innerHTML = '<p class="hint">Verifying…</p>';
      try {
        const res = await fetch('/v1/verify/' + encodeURIComponent(id));
        const r = await res.json();
        if (!r.found) { $('#verify-result').innerHTML = '<p class="result-bad">No artifact with that ID.</p>'; return; }
        const ok = r.signature_valid && r.content_hash_intact;
        $('#verify-result').innerHTML =
          '<p class="' + (ok ? 'result-good' : 'result-bad') + '">' + (ok ? '✓ Signature valid & content intact' : '✗ Verification failed') + '</p>' +
          '<dl class="kv">' +
          '<dt>Artifact ID</dt><dd>' + esc(r.artifact_id) + '</dd>' +
          '<dt>Action</dt><dd>' + esc(r.action) + '</dd>' +
          '<dt>Locale</dt><dd>' + esc(r.locale) + '</dd>' +
          '<dt>Notice version</dt><dd>' + esc(r.notice_version_hash) + '</dd>' +
          '<dt>Timestamp</dt><dd>' + esc(r.timestamp) + '</dd>' +
          '<dt>Signing key</dt><dd>' + esc(r.key_id) + '</dd>' +
          '<dt>Signature valid</dt><dd>' + (r.signature_valid ? 'yes' : 'no') + '</dd>' +
          '<dt>Content hash intact</dt><dd>' + (r.content_hash_intact ? 'yes' : 'no') + '</dd>' +
          '</dl>' +
          '<p class="hint">No personal data is exposed by verification — only the proof surface.</p>';
      } catch (err) { $('#verify-result').innerHTML = '<p class="result-bad">' + esc(err.message) + '</p>'; }
    };
  }

  window.CG = { initAuthPage, initDashboard, initVerifyPage };
})();
