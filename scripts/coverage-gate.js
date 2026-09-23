// scripts/coverage-gate.js
// ─────────────────────────────────────────────────────────────────────────
// Runs the test suite with V8 coverage and fails the build if the aggregate
// falls below the configured thresholds. Zero dependencies — parses the
// built-in `--experimental-test-coverage` summary table.
//
//   npm run coverage:gate
//
// Thresholds are overridable via env so CI can tighten them over time:
//   COVERAGE_MIN_LINES   (default 85)
//   COVERAGE_MIN_BRANCH  (default 70)
//   COVERAGE_MIN_FUNCS   (default 80)
//
// Note on the defaults: production-only code paths that cannot execute in the
// registry-restricted CI sandbox — the AWS KMS signer (src/crypto/kms.js) and
// the Postgres adapter/partitions (src/db/adapters/postgres.js, partitions.js)
// — are exercised only by their interface stubs, so they drag the aggregate
// down. The thresholds are set to gate the exercised application core without
// demanding coverage of paths that require live AWS/Postgres.
// ─────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';

const MIN = {
  lines: Number(process.env.COVERAGE_MIN_LINES || 85),
  branch: Number(process.env.COVERAGE_MIN_BRANCH || 70),
  funcs: Number(process.env.COVERAGE_MIN_FUNCS || 80),
};

const run = spawnSync(
  process.execPath,
  ['--experimental-sqlite', '--experimental-test-coverage', '--test', 'tests/*.test.js'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

const out = `${run.stdout || ''}\n${run.stderr || ''}`;

// A failing test must fail the gate too — coverage of broken code is worthless.
if (run.status !== 0) {
  process.stdout.write(out);
  console.error('\n✗ coverage gate: the test suite did not pass; fix tests before checking coverage.');
  process.exit(run.status || 1);
}

// Parse the aggregate row:  "# all files | 89.56 | 76.59 | 83.87 |"
const row = out.split('\n').find((l) => /^#\s*all files/i.test(l));
if (!row) {
  process.stdout.write(out);
  console.error('\n✗ coverage gate: could not find the coverage summary. Did the run include --experimental-test-coverage?');
  process.exit(2);
}

const nums = row.split('|').slice(1).map((c) => parseFloat(c.trim()));
const [lines, branch, funcs] = nums;
const got = { lines, branch, funcs };

const checks = [
  ['lines', lines, MIN.lines],
  ['branch', branch, MIN.branch],
  ['funcs', funcs, MIN.funcs],
];

let failed = false;
console.log('\nCoverage gate');
console.log('─────────────────────────────────────────────');
for (const [label, value, min] of checks) {
  const ok = Number.isFinite(value) && value >= min;
  if (!ok) failed = true;
  console.log(`  ${label.padEnd(8)} ${String(value).padStart(6)}%   (min ${min}%)   ${ok ? '✓' : '✗ BELOW THRESHOLD'}`);
}
console.log('─────────────────────────────────────────────');

if (failed) {
  console.error('\n✗ coverage gate failed.');
  console.error(`  got ${JSON.stringify(got)} vs min ${JSON.stringify(MIN)}`);
  process.exit(1);
}
console.log('\n✓ coverage gate passed.');
