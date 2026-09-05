// src/server.js — HTTP entrypoint. Wires DB + KMS + routes + static dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db/index.js';
import { migrate } from './db/migrate.js';
import { Repo } from './db/repo.js';
import { createKeyManager } from './crypto/kms.js';
import { Router } from './api/http.js';
import { registerRoutes } from './api/routes.js';
import { log } from './lib/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const WIDGET_DIR = path.join(__dirname, '..', 'widget', 'dist');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.map': 'application/json' };

export async function buildServer(env = process.env, hooks = {}) {
  const db = await openDatabase(env.DATABASE_URL);
  const m = await migrate(db);
  log.info('migrate', { backend: db.dialect, ...m });
  const repo = new Repo(db);
  const km = createKeyManager(env);

  const router = new Router({ repo, km });

  // Static: dashboard (public/) and built widget (widget/dist/).
  const serveStatic = (baseDir, urlPrefix) => (relPath) => ({ req, res, send }) => {
    const file = path.join(baseDir, relPath);
    if (!file.startsWith(baseDir)) return send(403, { error: 'forbidden' });
    if (!fs.existsSync(file)) return send(404, { error: 'not_found' });
    const ext = path.extname(file);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  };

  registerRoutes(router, { repo, km, hooks });

  // Dashboard routes (after API so /v1/* wins).
  router.get('/', ({ req, res, send }) => serveStatic(PUBLIC_DIR, '/')('index.html')({ req, res, send }));
  router.get('/dashboard', ({ req, res, send }) => serveStatic(PUBLIC_DIR, '/')('dashboard.html')({ req, res, send }));
  router.get('/verify', ({ req, res, send }) => serveStatic(PUBLIC_DIR, '/')('verify.html')({ req, res, send }));
  router.get('/app.js', ({ req, res, send }) => serveStatic(PUBLIC_DIR, '/')('app.js')({ req, res, send }));
  router.get('/styles.css', ({ req, res, send }) => serveStatic(PUBLIC_DIR, '/')('styles.css')({ req, res, send }));

  // Serve the widget bundle + demo.
  router.get('/widget/consentgrid.js', ({ req, res, send }) => {
    const dist = path.join(WIDGET_DIR, 'consentgrid.js');
    const srcFallback = path.join(__dirname, '..', 'widget', 'src', 'consentgrid.js');
    const file = fs.existsSync(dist) ? dist : srcFallback;
    if (!fs.existsSync(file)) return send(404, { error: 'widget_not_built', hint: 'run npm run build:widget' });
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' });
    res.end(fs.readFileSync(file));
  });
  router.get('/widget/demo', ({ req, res, send }) => serveStatic(PUBLIC_DIR, '/')('widget-demo.html')({ req, res, send }));
  router.get('/widget/sw.js', ({ req, res, send }) => {
    const file = path.join(__dirname, '..', 'widget', 'src', 'sw.js');
    if (!fs.existsSync(file)) return send(404, {});
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });

  return { db, repo, km, router };
}

// CLI entry
// if (import.meta.url === `file://${process.argv[1]}`) {  --> error on Node 20.3.0, see
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadDotenv } = await import('./lib/env.js');
  loadDotenv();
  const { router } = await buildServer();
  router.listen(Number(process.env.PORT || 8080));
}
