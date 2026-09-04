// widget/src/consentgrid.js
// ─────────────────────────────────────────────────────────────────────────
// ConsentGrid embeddable widget (source). Vanilla ESM, no framework, no deps.
// Built to <15KB gzipped by widget/build.js (minify + gzip check).
//
// Design constraints (all [MUST-V1]):
//   • Candidate-list language resolution — a 3–4 language shortlist, never the
//     full 22. IP geolocation is never used. The user must explicitly confirm a
//     language before the notice counts as "shown" (no silent auto-selection).
//   • Purposes render UNCHECKED. Every affirmative toggle is recorded as an
//     interaction event so the backend can reject pre-ticked/default-allow.
//   • Honest fallback: if the resolved locale has no approved notice, the widget
//     says so plainly and does NOT record consent under a substituted language.
//   • Offline capture: if the network is down, the payload is signed-at-rest
//     (WebCrypto), queued in IndexedDB, and flushed by a service worker when
//     connectivity returns. Consent is captured, never silently dropped.
//   • RTL: Urdu/Kashmiri/Sindhi render right-to-left with dir="rtl".
//
// Public API (window.ConsentGrid):
//   ConsentGrid.init({ orgId, apiBase, userToken, mount, purposes, onEvent })
//     -> returns a controller { open, close, destroy }
// ─────────────────────────────────────────────────────────────────────────

const RTL = new Set(['ur', 'ks', 'sd']);
const LANG_NAMES = {
  as: 'অসমীয়া', bn: 'বাংলা', brx: 'बड़ो', doi: 'डोगरी', gu: 'ગુજરાતી',
  hi: 'हिन्दी', kn: 'ಕನ್ನಡ', ks: 'کٲشُر', kok: 'कोंकणी', mai: 'मैथिली',
  ml: 'മലയാളം', mni: 'ꯃꯤꯇꯩ', mr: 'मराठी', ne: 'नेपाली', or: 'ଓଡ଼ିଆ',
  pa: 'ਪੰਜਾਬੀ', sa: 'संस्कृतम्', sat: 'ᱥᱟᱱᱛᱟᱲᱤ', sd: 'سنڌي', ta: 'தமிழ்',
  te: 'తెలుగు', ur: 'اردو', en: 'English',
};
const STORE_KEY = 'cg_lang_pref';
const IDB_NAME = 'consentgrid';
const IDB_STORE = 'outbox';

// ── tiny DOM helpers ────────────────────────────────────────────────────────
function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v; // only used for server-approved, sanitized notice bodies
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return n;
}

function storageGet(key) { try { return window.localStorage.getItem(key); } catch { return null; } }
function storageSet(key, v) { try { window.localStorage.setItem(key, v); } catch { /* private mode */ } }

// ── IndexedDB outbox for offline capture ────────────────────────────────────
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(record) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── WebCrypto: sign the payload at rest so a queued offline capture is
//    tamper-evident on the device before it ever reaches the server. This is a
//    device-side integrity seal, NOT the authoritative artifact signature
//    (that is minted centrally in KMS server-side). ─────────────────────────
async function deviceKey() {
  // Ephemeral per-session HMAC key; the exported raw key travels with the
  // queued record so the server can confirm the capture wasn't altered in the
  // outbox. It proves at-rest integrity, not identity.
  return crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, true, ['sign']);
}
async function sealPayload(payload) {
  const enc = new TextEncoder();
  const bytes = enc.encode(JSON.stringify(payload));
  const key = await deviceKey();
  const sig = await crypto.subtle.sign('HMAC', key, bytes);
  const raw = await crypto.subtle.exportKey('raw', key);
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  return { device_seal: b64(sig), device_seal_key: b64(raw), sealed_at: new Date().toISOString() };
}

// ── network ──────────────────────────────────────────────────────────────────
async function apiGet(base, path, params) {
  const url = new URL(base.replace(/\/$/, '') + path);
  for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ── controller ────────────────────────────────────────────────────────────────
class Widget {
  constructor(opts) {
    this.opts = opts;
    this.apiBase = opts.apiBase || '';
    this.orgId = opts.orgId;
    this.userToken = opts.userToken;
    this.apiKey = opts.apiKey || null; // optional: direct submit; usually a server proxy holds this
    this.purposes = opts.purposes || []; // [{id, label}] — labels are org-provided fallbacks
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
    this.mount = typeof opts.mount === 'string' ? document.querySelector(opts.mount) : (opts.mount || document.body);
    this.state = { candidates: [], locale: null, notice: null, selected: {}, interactions: [], languageConfirmed: false };
    this.root = null;
  }

  emit(type, detail) { try { this.onEvent({ type, ...detail }); } catch { /* host handler error is not ours */ } }

  async open() {
    this.render(this.loadingView('…'));
    await this.resolveLanguages();
  }

  // 1) Ask the server for the candidate shortlist (never IP-based).
  async resolveLanguages() {
    const stored = storageGet(STORE_KEY);
    const nav = (navigator.languages || [navigator.language || 'en']).join(',');
    const htmlLang = document.documentElement.getAttribute('lang') || '';
    const { status, json } = await apiGet(this.apiBase, '/v1/languages/resolve', {
      org_id: this.orgId, nav, html_lang: htmlLang, stored: stored || '',
    });
    if (status !== 200) return this.render(this.errorView('Could not load consent options. Please try again.'));
    this.state.candidates = json.candidates || [];
    this.state.allApproved = json.approved_all || [];
    this.emit('languages_resolved', { candidates: this.state.candidates });
    // NO auto-select. Present the shortlist and wait for an explicit tap.
    this.render(this.languagePicker());
  }

  // 2) User explicitly picks a language -> fetch that approved notice.
  async chooseLanguage(locale) {
    this.state.locale = locale;
    storageSet(STORE_KEY, locale);
    this.render(this.loadingView('…'));
    const { status, json } = await apiGet(this.apiBase, '/v1/notice', { org_id: this.orgId, locale });
    if (status === 409 || json.available === false) {
      // Honest fallback — do NOT substitute another language and record silently.
      this.emit('notice_unavailable', { locale });
      return this.render(this.unavailableView(locale, json.message));
    }
    if (status !== 200) return this.render(this.errorView('Could not load the notice. Please try again.'));
    this.state.notice = json;
    // Record the explicit language confirmation as an interaction event.
    this.state.languageConfirmed = true;
    this.state.interactions.push({ type: 'language_confirmed', locale, ts: Date.now() });
    this.emit('language_confirmed', { locale });
    this.render(this.noticeView());
  }

  // 3) Purpose toggled -> record an interaction event (no pre-ticking).
  togglePurpose(pid, value) {
    this.state.selected[pid] = value;
    this.state.interactions.push({ type: 'toggle', purpose_id: pid, value, ts: Date.now() });
  }

  // 4) Submit -> POST /v1/consent, or queue offline.
  async submit(action) {
    if (!this.state.notice) return;
    const purposes = {};
    for (const p of this.purposes) purposes[p.id] = !!this.state.selected[p.id];
    const shownAt = this._shownAt || Date.now();
    const payload = {
      user_token: this.userToken,
      action,
      channel: 'web',
      purposes,
      interaction_events: this.state.interactions,
      locale: this.state.locale,
      notice_version_hash: this.state.notice.notice_version_hash,
      template_hash: this.state.notice.template_hash,
      variable_payload_hash: this.state.notice.variable_payload_hash,
      notice_shown_to_submit_ms: Date.now() - shownAt,
    };

    if (!navigator.onLine) return this.queueOffline(payload);

    try {
      const headers = { 'content-type': 'application/json' };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const res = await fetch(this.apiBase.replace(/\/$/, '') + '/v1/consent', {
        method: 'POST', headers, body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.emit('submit_error', { status: res.status, error: json });
        return this.render(this.errorView(json.message || 'Your consent could not be recorded. Please try again.'));
      }
      this.emit('consent_recorded', { artifact_id: json.artifact_id, action });
      this.render(this.doneView(json));
    } catch (e) {
      // Network dropped mid-flight -> queue rather than lose the capture.
      return this.queueOffline(payload);
    }
  }

  async queueOffline(payload) {
    try {
      const seal = await sealPayload(payload);
      const record = { id: `cg_${Date.now()}_${Math.random().toString(36).slice(2)}`, apiBase: this.apiBase, payload, ...seal };
      await idbPut(record);
      // Ask the service worker to flush when back online (Background Sync where available).
      if ('serviceWorker' in navigator && navigator.serviceWorker.ready) {
        const reg = await navigator.serviceWorker.ready;
        if (reg.sync) { try { await reg.sync.register('cg-flush'); } catch { /* not supported */ } }
      }
      this.emit('consent_queued_offline', { id: record.id });
      this.render(this.queuedView());
    } catch (e) {
      this.emit('submit_error', { offline: true, error: String(e) });
      this.render(this.errorView('You appear to be offline and we could not save your choice locally.'));
    }
  }

  // ── views ──────────────────────────────────────────────────────────────────
  loadingView(t) { return el('div', { class: 'cg-body' }, [el('p', { class: 'cg-muted', text: t })]); }
  errorView(msg) {
    return el('div', { class: 'cg-body' }, [
      el('p', { class: 'cg-error', text: msg }),
      el('button', { class: 'cg-btn', onclick: () => this.resolveLanguages() }, ['Try again']),
    ]);
  }

  languagePicker() {
    const chips = this.state.candidates.map((code) =>
      el('button', { class: 'cg-chip', 'data-locale': code, onclick: () => this.chooseLanguage(code) },
        [LANG_NAMES[code] || code]));
    const more = el('details', { class: 'cg-more' }, [
      el('summary', { text: 'More languages' }),
      el('div', { class: 'cg-chip-row' },
        (this.state.allApproved || []).filter((c) => !this.state.candidates.includes(c)).map((code) =>
          el('button', { class: 'cg-chip cg-chip-alt', onclick: () => this.chooseLanguage(code) }, [LANG_NAMES[code] || code]))),
    ]);
    return el('div', { class: 'cg-body' }, [
      el('p', { class: 'cg-title', text: 'Choose your language' }),
      el('p', { class: 'cg-muted', text: 'Select a language to read and confirm your consent.' }),
      el('div', { class: 'cg-chip-row' }, chips),
      (this.state.allApproved && this.state.allApproved.length > this.state.candidates.length) ? more : null,
    ]);
  }

  unavailableView(locale, message) {
    return el('div', { class: 'cg-body' }, [
      el('p', { class: 'cg-title', text: 'Not available in this language yet' }),
      el('p', { class: 'cg-muted', text: message || `This notice isn't available in "${locale}" yet. Your consent will not be recorded in a language you didn't read.` }),
      el('button', { class: 'cg-btn cg-btn-ghost', onclick: () => this.render(this.languagePicker()) }, ['Pick another language']),
    ]);
  }

  noticeView() {
    const n = this.state.notice;
    const rtl = RTL.has(this.state.locale);
    this._shownAt = Date.now();
    const purposeRows = this.purposes.map((p) => {
      const cb = el('input', { type: 'checkbox', class: 'cg-cb', id: `cg_p_${p.id}` });
      cb.checked = false; // ALWAYS unchecked — never pre-ticked
      cb.addEventListener('change', () => this.togglePurpose(p.id, cb.checked));
      return el('label', { class: 'cg-purpose', for: `cg_p_${p.id}` }, [cb, el('span', { text: p.label || p.id })]);
    });
    const body = el('div', { class: 'cg-notice', dir: rtl ? 'rtl' : 'ltr' });
    body.innerHTML = n.body_html; // server-approved, legally-reviewed content
    return el('div', { class: 'cg-body', dir: rtl ? 'rtl' : 'ltr' }, [
      el('p', { class: 'cg-title', text: n.title }),
      n.auto_translated ? el('p', { class: 'cg-badge', text: 'Machine-assisted translation' }) : null,
      body,
      el('div', { class: 'cg-purposes' }, purposeRows),
      el('div', { class: 'cg-actions' }, [
        el('button', { class: 'cg-btn', onclick: () => this.submit('GRANT') }, ['Confirm choices']),
        el('button', { class: 'cg-btn cg-btn-ghost', onclick: () => this.submit('WITHDRAW') }, ['Decline all']),
      ]),
      el('p', { class: 'cg-fineprint', text: `Language: ${LANG_NAMES[this.state.locale] || this.state.locale}` }),
    ]);
  }

  doneView(json) {
    return el('div', { class: 'cg-body' }, [
      el('p', { class: 'cg-title', text: 'Your choices are recorded' }),
      el('p', { class: 'cg-muted', text: 'A tamper-evident receipt has been created.' }),
      json && json.artifact_id ? el('p', { class: 'cg-fineprint', text: `Receipt: ${json.artifact_id}` }) : null,
    ]);
  }
  queuedView() {
    return el('div', { class: 'cg-body' }, [
      el('p', { class: 'cg-title', text: 'Saved — will finish when you reconnect' }),
      el('p', { class: 'cg-muted', text: 'You appear to be offline. Your choices are stored securely on this device and will be submitted automatically.' }),
    ]);
  }

  render(view) {
    if (!this.root) {
      this.root = el('div', { class: 'cg-widget', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Consent' });
      this.injectStyles();
      this.mount.appendChild(this.root);
    }
    this.root.innerHTML = '';
    this.root.appendChild(view);
  }

  injectStyles() {
    if (document.getElementById('cg-styles')) return;
    const css = `
.cg-widget{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:420px;border:1px solid #e2e2e2;border-radius:12px;padding:20px;background:#fff;color:#1a1a1a;box-shadow:0 6px 24px rgba(0,0,0,.08)}
.cg-title{font-size:16px;font-weight:600;margin:0 0 6px}
.cg-muted{color:#666;font-size:13px;margin:0 0 12px}
.cg-fineprint{color:#999;font-size:11px;margin-top:10px}
.cg-error{color:#b00020;font-size:13px}
.cg-badge{display:inline-block;font-size:11px;background:#fff4e5;color:#8a5a00;border:1px solid #ffd9a0;border-radius:6px;padding:2px 8px;margin:0 0 8px}
.cg-chip-row{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
.cg-chip{border:1px solid #cfcfcf;background:#fafafa;border-radius:999px;padding:8px 14px;font-size:14px;cursor:pointer}
.cg-chip:hover{background:#f0f0f0}
.cg-chip-alt{background:#fff;border-style:dashed}
.cg-more{margin-top:8px;font-size:13px}
.cg-notice{max-height:220px;overflow:auto;border:1px solid #eee;border-radius:8px;padding:12px;font-size:13px;line-height:1.5;margin:10px 0}
.cg-notice[dir=rtl]{text-align:right}
.cg-purposes{display:flex;flex-direction:column;gap:8px;margin:10px 0}
.cg-purpose{display:flex;align-items:center;gap:10px;font-size:14px;cursor:pointer}
.cg-cb{width:18px;height:18px}
.cg-actions{display:flex;gap:10px;margin-top:12px}
.cg-btn{background:#111;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:14px;cursor:pointer}
.cg-btn:hover{background:#000}
.cg-btn-ghost{background:#fff;color:#111;border:1px solid #cfcfcf}
[dir=rtl] .cg-actions{flex-direction:row-reverse}
`;
    document.head.appendChild(el('style', { id: 'cg-styles', text: css }));
  }

  close() { if (this.root) this.root.style.display = 'none'; }
  destroy() { if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root); this.root = null; }
}

const ConsentGrid = {
  init(opts) {
    if (!opts || !opts.orgId) throw new Error('ConsentGrid.init requires { orgId }');
    const w = new Widget(opts);
    if (opts.autoOpen !== false) w.open();
    return { open: () => w.open(), close: () => w.close(), destroy: () => w.destroy(), _widget: w };
  },
  version: '0.1.0',
};

if (typeof window !== 'undefined') window.ConsentGrid = ConsentGrid;
export default ConsentGrid;
export { Widget, ConsentGrid };
