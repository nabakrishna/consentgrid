// widget/src/sw.js
// ─────────────────────────────────────────────────────────────────────────
// ConsentGrid offline-capture service worker.
//
// The widget queues consent payloads in IndexedDB (store "outbox") when the
// device is offline or a submit fails mid-flight. This worker flushes that
// queue back to POST /v1/consent when connectivity returns — via the Background
// Sync event where supported, and as a fallback whenever the SW starts up or
// receives a 'cg-flush' message.
//
// Consent is captured, never silently dropped. A queued item is only removed
// from the outbox after the server confirms it (2xx) or explicitly rejects it
// as a permanent 4xx (bad/duplicate) — transient/5xx errors are left to retry.
// ─────────────────────────────────────────────────────────────────────────

const IDB_NAME = 'consentgrid';
const IDB_STORE = 'outbox';

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
function idbAll() {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}
function idbDelete(id) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

async function flushOutbox() {
  const items = await idbAll();
  for (const item of items) {
    try {
      const res = await fetch((item.apiBase || '').replace(/\/$/, '') + '/v1/consent', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Device-at-rest integrity seal travels alongside so the server can
          // confirm the queued capture was not altered while offline.
          'CG-Device-Seal': item.device_seal || '',
          'CG-Device-Seal-Key': item.device_seal_key || '',
        },
        body: JSON.stringify(item.payload),
      });
      if (res.ok) {
        await idbDelete(item.id);
      } else if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        // Permanent rejection (validation/duplicate) — drop so we don't loop forever.
        await idbDelete(item.id);
      }
      // 5xx / 429 / network: leave in outbox for the next flush.
    } catch {
      // Still offline — stop; we'll be retried on the next sync/startup.
      break;
    }
  }
}

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim().then(flushOutbox)));
self.addEventListener('sync', (e) => { if (e.tag === 'cg-flush') e.waitUntil(flushOutbox()); });
self.addEventListener('message', (e) => { if (e.data === 'cg-flush') e.waitUntil ? e.waitUntil(flushOutbox()) : flushOutbox(); });
self.addEventListener('online', () => flushOutbox());
