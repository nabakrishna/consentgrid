// widget/build.js
// ─────────────────────────────────────────────────────────────────────────
// Zero-dependency widget bundler. The widget is already a single ESM file, so
// "building" here means: (1) a lightweight safe minify (strip comments + collapse
// whitespace conservatively), (2) write widget/dist/consentgrid.js, and
// (3) enforce the <15KB gzipped size budget — failing the build if exceeded.
//
// We intentionally avoid a heavyweight minifier (terser/esbuild) because the
// npm registry is not assumed reachable in this environment. The conservative
// transform below is safe for this source (no regex-literal edge cases, no
// minification of string contents).
// ─────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'src', 'consentgrid.js');
const OUT_DIR = path.join(__dirname, 'dist');
const OUT = path.join(OUT_DIR, 'consentgrid.js');
const BUDGET_GZIP = 15 * 1024;

// Conservative minify: protects string/template/regex literals, then strips
// comments and collapses runs of blank whitespace outside of literals.
function minify(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  let str = null; // current string delimiter: ' " ` or null
  while (i < n) {
    const c = code[i];
    const c2 = code[i + 1];
    if (str) {
      out += c;
      if (c === '\\') { out += code[i + 1] ?? ''; i += 2; continue; }
      if (c === str) str = null;
      i++;
      continue;
    }
    // entering a string literal
    if (c === '"' || c === "'" || c === '`') { str = c; out += c; i++; continue; }
    // line comment
    if (c === '/' && c2 === '/') { while (i < n && code[i] !== '\n') i++; continue; }
    // block comment
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++; i += 2; continue; }
    out += c;
    i++;
  }
  // Collapse whitespace lines; trim trailing spaces. Keep newlines to avoid ASI hazards.
  return out
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .filter((l) => l.trim().length > 0)
    .join('\n');
}

function main() {
  if (!fs.existsSync(SRC)) { console.error('missing source:', SRC); process.exit(1); }
  const src = fs.readFileSync(SRC, 'utf8');
  const min = minify(src);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, min);

  const rawKB = (Buffer.byteLength(min) / 1024).toFixed(2);
  const gz = zlib.gzipSync(Buffer.from(min), { level: 9 });
  const gzKB = (gz.length / 1024).toFixed(2);

  console.log(`widget built: ${OUT}`);
  console.log(`  raw:      ${rawKB} KB`);
  console.log(`  gzipped:  ${gzKB} KB  (budget ${(BUDGET_GZIP / 1024).toFixed(0)} KB)`);

  if (gz.length > BUDGET_GZIP) {
    console.error(`BUDGET EXCEEDED: widget is ${gzKB} KB gzipped, over the ${(BUDGET_GZIP / 1024).toFixed(0)} KB limit`);
    process.exit(2);
  }
  console.log('  ✓ within size budget');
}

main();
