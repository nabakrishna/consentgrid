// src/api/http.js
// Minimal, dependency-free HTTP framework on node:http.
// Provides routing, JSON body parsing, CORS, and a request context. Fastify
// would be the drop-in at scale, but the registry is unreachable in this
// build environment, so we implement the slice on the stdlib. The route
// handlers are framework-agnostic ({req,res,params,query,body,ctx}).

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { log } from '../lib/log.js';

export class Router {
  #routes = [];
  #ctx;
  constructor(ctx) { this.#ctx = ctx; }

  add(method, pattern, handler) {
    // pattern like '/v1/artifacts/:id'
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
    this.#routes.push({ method, rx, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  del(p, h) { this.add('DELETE', p, h); }

  handler() {
    return async (req, res) => {
      const reqId = randomUUID();
      const rlog = log.child({ req_id: reqId });
      res.setHeader('access-control-allow-origin', req.headers.origin || '*');
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-allow-headers', 'authorization,content-type,x-api-key');
      res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('vary', 'origin');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

      const url = new URL(req.url, 'http://localhost');
      const query = Object.fromEntries(url.searchParams.entries());
      const send = (code, obj, headers = {}) => {
        const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
        res.writeHead(code, { 'content-type': typeof obj === 'string' ? 'text/html; charset=utf-8' : 'application/json', ...headers });
        res.end(body);
      };

      try {
        for (const r of this.#routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.rx);
          if (!m) continue;
          const params = {};
          r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
          const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : null;
          const context = { ...this.#ctx, log: rlog, reqId, ip: clientIp(req), userAgent: req.headers['user-agent'] || '' };
          return await r.handler({ req, res, params, query, body, ctx: context, send });
        }
        send(404, { error: 'not_found', path: url.pathname });
      } catch (e) {
        if (e && e.statusCode) return send(e.statusCode, { error: e.code || 'error', message: e.message });
        rlog.error('unhandled', { err: String(e && e.stack || e) });
        send(500, { error: 'internal_error' });
      }
    };
  }

  listen(port) {
    const server = http.createServer(this.handler());
    server.listen(port, () => log.info('listening', { port }));
    return server;
  }
}

export function httpError(statusCode, code, message) {
  const e = new Error(message || code);
  e.statusCode = statusCode; e.code = code;
  return e;
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(httpError(413, 'payload_too_large', 'body exceeds 1MB')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(httpError(400, 'invalid_json', 'body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}
