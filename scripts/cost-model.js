// scripts/cost-model.js
// ─────────────────────────────────────────────────────────────────────────
// Infrastructure cost model for the ConsentGrid platform. This is an ESTIMATE,
// not a quote: it is a transparent, parametric model you can adjust. Every
// assumption is a named constant with a source note; override any of them via
// environment variables (see ASSUMPTIONS below).
//
//   npm run cost-model                 # human-readable table
//   node scripts/cost-model.js --json  # machine-readable
//   node scripts/cost-model.js --markdown   # for docs/COST-MODEL.md
//
// Prices approximate AWS ap-south-1 (Mumbai) on-demand list prices, 2025. They
// are list prices before committed-use / Savings Plans discounts. The dominant
// MARGINAL driver is KMS asymmetric signing: one ECDSA sign per minted artifact.
// ─────────────────────────────────────────────────────────────────────────

const N = (v, d) => (v === undefined || v === '' ? d : Number(v));
const E = process.env;

const ASSUMPTIONS = {
  // ── Request amplification per consent event ──────────────────────────────
  // A consent event drives a few origin hits (language resolve + notice fetch,
  // mostly edge-cached, + the consent POST + occasional history/verify).
  originReqsPerEvent: N(E.CM_ORIGIN_REQS_PER_EVENT, 2.5),
  // Minted artifacts per event: grants + a fraction of withdrawals/corrections.
  artifactsPerEvent: N(E.CM_ARTIFACTS_PER_EVENT, 1.15),
  // Webhook fan-out: standardized directives emitted per event (per-purpose).
  webhookDeliveriesPerEvent: N(E.CM_WEBHOOKS_PER_EVENT, 1.5),

  // ── KMS (the marginal cost driver) ───────────────────────────────────────
  kmsKeysMonthly: N(E.CM_KMS_KEYS, 2),            // active + previous (rotation) → $1/key/mo
  kmsKeyPriceMonthly: N(E.CM_KMS_KEY_PRICE, 1.0), // $/key/month
  kmsSignPricePer10k: N(E.CM_KMS_SIGN_PRICE_10K, 0.15), // $/10k asymmetric ECC ops

  // ── Compute (Fargate-style) ──────────────────────────────────────────────
  vcpuHrPrice: N(E.CM_VCPU_HR, 0.04656),   // $/vCPU-hour (ap-south-1)
  gbHrPrice: N(E.CM_GB_HR, 0.00511),       // $/GB-hour
  gbPerVcpu: N(E.CM_GB_PER_VCPU, 2),       // memory per vCPU
  reqsPerVcpuSec: N(E.CM_REQS_PER_VCPU_SEC, 120), // sustained effective throughput @ target util
  minApiTasks: N(E.CM_MIN_API_TASKS, 2),   // HA floor (multi-AZ)
  workerVcpu: N(E.CM_WORKER_VCPU, 0.5),    // webhook worker baseline

  // ── Database (managed Postgres) ──────────────────────────────────────────
  // Instance is chosen by write volume (see dbInstanceFor). Storage grows with
  // retained artifacts.
  bytesPerArtifact: N(E.CM_BYTES_PER_ARTIFACT, 2048), // row + indexes + WAL amortized
  retentionMonths: N(E.CM_RETENTION_MONTHS, 84),      // 7y default (see LEGAL-OPEN-QUESTIONS.md)
  storageGbMonth: N(E.CM_STORAGE_GB_MONTH, 0.1375),   // gp3 $/GB-month
  backupMultiplier: N(E.CM_BACKUP_MULT, 1.0),         // PITR/backup ≈ 1x live storage

  // ── Egress + object storage + overhead ───────────────────────────────────
  egressPerGb: N(E.CM_EGRESS_GB, 0.1093),   // $/GB out (Mumbai)
  kbPerApiResponse: N(E.CM_KB_PER_RESP, 6), // avg JSON/notice response size
  kbPerWebhook: N(E.CM_KB_PER_WEBHOOK, 2),
  s3GbMonth: N(E.CM_S3_GB_MONTH, 0.025),    // exports + Merkle anchor logs
  observabilityPct: N(E.CM_OBSERVABILITY_PCT, 0.15), // logs/metrics/traces as % of infra
  secretsMonthly: N(E.CM_SECRETS_MONTHLY, 2.0),      // Secrets Manager for pepper etc.
};

const HOURS_PER_MONTH = 730;
const SECONDS_PER_MONTH = HOURS_PER_MONTH * 3600;

function dbInstanceFor(eventsPerMonth, a) {
  // Pick a managed Postgres tier by sustained write rate. Multi-AZ ≈ 2x.
  const writesPerSec = (eventsPerMonth * a.artifactsPerEvent) / SECONDS_PER_MONTH;
  let tier;
  if (writesPerSec < 5) tier = { name: 'db.t4g.medium (2 vCPU / 4GB), Multi-AZ', hourly: 0.114 };
  else if (writesPerSec < 60) tier = { name: 'db.r6g.large (2 vCPU / 16GB), Multi-AZ', hourly: 0.58 };
  else tier = { name: 'db.r6g.2xlarge (8 vCPU / 64GB) + read replica', hourly: 2.03 };
  return { ...tier, writesPerSec, monthly: tier.hourly * HOURS_PER_MONTH };
}

function costFor(eventsPerMonth, a = ASSUMPTIONS) {
  // ── KMS ──
  const signs = eventsPerMonth * a.artifactsPerEvent;
  const kmsSign = (signs / 10000) * a.kmsSignPricePer10k;
  const kmsKeys = a.kmsKeysMonthly * a.kmsKeyPriceMonthly;
  const kms = kmsSign + kmsKeys;

  // ── Compute ──
  const originReqs = eventsPerMonth * a.originReqsPerEvent;
  const avgReqPerSec = originReqs / SECONDS_PER_MONTH;
  const neededVcpu = avgReqPerSec / a.reqsPerVcpuSec;
  const apiVcpu = Math.max(a.minApiTasks, Math.ceil(neededVcpu * 100) / 100);
  const totalVcpu = apiVcpu + a.workerVcpu;
  const computeHourly = totalVcpu * (a.vcpuHrPrice + a.gbPerVcpu * a.gbHrPrice);
  const compute = computeHourly * HOURS_PER_MONTH;

  // ── Database ──
  const db = dbInstanceFor(eventsPerMonth, a);
  const retainedArtifacts = eventsPerMonth * a.artifactsPerEvent * a.retentionMonths;
  const liveGb = (retainedArtifacts * a.bytesPerArtifact) / 1e9;
  const storage = liveGb * a.storageGbMonth * (1 + a.backupMultiplier);
  const database = db.monthly + storage;

  // ── Egress + object storage ──
  const apiEgressGb = (originReqs * a.kbPerApiResponse * 1024) / 1e9;
  const webhookEgressGb = (eventsPerMonth * a.webhookDeliveriesPerEvent * a.kbPerWebhook * 1024) / 1e9;
  const egress = (apiEgressGb + webhookEgressGb) * a.egressPerGb;
  const s3 = liveGb * 0.05 * a.s3GbMonth; // exports/anchor logs ≈ 5% of live volume

  // ── Overhead ──
  const infraSubtotal = kms + compute + database + egress + s3;
  const observability = infraSubtotal * a.observabilityPct;
  const secrets = a.secretsMonthly;

  const total = infraSubtotal + observability + secrets;

  return {
    eventsPerMonth,
    lineItems: {
      'KMS signing (ECDSA)': kmsSign,
      'KMS keys': kmsKeys,
      Compute: compute,
      'DB instance': db.monthly,
      'DB + backup storage': storage,
      Egress: egress,
      'Object storage': s3,
      Observability: observability,
      Secrets: secrets,
    },
    detail: {
      signsPerMonth: Math.round(signs),
      apiVcpu, totalVcpu: Math.round(totalVcpu * 100) / 100,
      dbInstance: db.name, writesPerSec: Math.round(db.writesPerSec * 100) / 100,
      retainedArtifacts: Math.round(retainedArtifacts), liveGb: Math.round(liveGb * 100) / 100,
    },
    total,
    costPer1kEvents: (total / eventsPerMonth) * 1000,
  };
}

const VOLUMES = [10_000, 1_000_000, 100_000_000];
const fmt = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const results = VOLUMES.map((v) => costFor(v));

function printTable() {
  console.log('\nConsentGrid — infrastructure cost model (estimate, AWS ap-south-1 list prices)\n');
  const rows = Object.keys(results[0].lineItems);
  const head = 'Line item'.padEnd(24) + VOLUMES.map((v) => v.toLocaleString().padStart(16)).join('');
  console.log(head);
  console.log('─'.repeat(head.length));
  for (const r of rows) {
    console.log(r.padEnd(24) + results.map((res) => fmt(res.lineItems[r]).padStart(16)).join(''));
  }
  console.log('─'.repeat(head.length));
  console.log('TOTAL / month'.padEnd(24) + results.map((res) => fmt(res.total).padStart(16)).join(''));
  console.log('Cost per 1,000 events'.padEnd(24) + results.map((res) => fmt(res.costPer1kEvents).padStart(16)).join(''));
  console.log('\nSizing detail:');
  results.forEach((res) => {
    console.log(`  ${res.eventsPerMonth.toLocaleString().padStart(12)} events/mo → ${res.detail.totalVcpu} vCPU, ${res.detail.dbInstance}, ${res.detail.liveGb} GB live, ${res.detail.signsPerMonth.toLocaleString()} KMS signs`);
  });
  console.log('\nThis is a transparent model, not a quote. Override any assumption via CM_* env vars (see scripts/cost-model.js).');
}

function printMarkdown() {
  const rows = Object.keys(results[0].lineItems);
  let md = '| Line item | ' + VOLUMES.map((v) => v.toLocaleString() + ' events/mo').join(' | ') + ' |\n';
  md += '|' + '---|'.repeat(VOLUMES.length + 1) + '\n';
  for (const r of rows) {
    md += `| ${r} | ` + results.map((res) => fmt(res.lineItems[r])).join(' | ') + ' |\n';
  }
  md += `| **Total / month** | ` + results.map((res) => '**' + fmt(res.total) + '**').join(' | ') + ' |\n';
  md += `| **Cost per 1,000 events** | ` + results.map((res) => '**' + fmt(res.costPer1kEvents) + '**').join(' | ') + ' |\n';
  console.log(md);
}

if (process.argv.includes('--json')) console.log(JSON.stringify({ assumptions: ASSUMPTIONS, results }, null, 2));
else if (process.argv.includes('--markdown')) printMarkdown();
else printTable();

export { costFor, ASSUMPTIONS };
