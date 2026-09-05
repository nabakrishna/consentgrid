// src/webhook/worker.js
// [MUST-V1] Separate worker process for webhook delivery. Run with:
//   npm run worker
// It polls for due deliveries and dispatches them with retry + DLQ.

import { openDatabase } from '../db/index.js';
import { Repo } from '../db/repo.js';
import { Dispatcher } from './dispatcher.js';
import { log } from '../lib/log.js';

const POLL_MS = Number(process.env.WEBHOOK_POLL_MS || 2000);

async function main() {
  const db = await openDatabase();
  const repo = new Repo(db);
  const dispatcher = new Dispatcher(repo);
  log.info('webhook_worker_started', { poll_ms: POLL_MS });

  let running = true;
  process.on('SIGINT', () => { running = false; });
  process.on('SIGTERM', () => { running = false; });

  while (running) {
    try {
      const results = await dispatcher.processOnce(50);
      if (results.length) {
        const dead = results.filter((r) => r.status === 'dead').length;
        const delivered = results.filter((r) => r.status === 'delivered').length;
        log.info('webhook_batch', { processed: results.length, delivered, dead });
      }
    } catch (e) {
      log.error('webhook_worker_error', { err: String(e) });
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (db.close) await db.close();
  log.info('webhook_worker_stopped');
}

main().catch((e) => { log.error('worker_fatal', { err: String(e) }); process.exit(1); });
