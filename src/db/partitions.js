// src/db/partitions.js
// [DESIGN-FOR] Postgres partition management for consent_artifacts.
//
// consent_artifacts is LIST-partitioned by org_id, each org sub-partitioned
// by month (RANGE on created_at). On SQLite these are no-ops (single table).
//
// Call ensureOrgPartition(db, orgId) at org signup, and ensureMonthPartition
// for the current + next month on a schedule so inserts never hit a missing
// partition under load.

function ym(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return { y, m, tag: `${y}_${m}` };
}
function monthBounds(date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
const orgTag = (orgId) => orgId.replace(/-/g, '').slice(0, 16);

export async function ensureOrgPartition(db, orgId) {
  if (db.dialect !== 'postgres') return;
  const t = `consent_artifacts_${orgTag(orgId)}`;
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${t} PARTITION OF consent_artifacts ` +
    `FOR VALUES IN ('${orgId}') PARTITION BY RANGE (created_at);`
  );
  await ensureMonthPartition(db, orgId, new Date());
  const next = new Date(); next.setUTCMonth(next.getUTCMonth() + 1);
  await ensureMonthPartition(db, orgId, next);
}

export async function ensureMonthPartition(db, orgId, date = new Date()) {
  if (db.dialect !== 'postgres') return;
  const parent = `consent_artifacts_${orgTag(orgId)}`;
  const { tag } = ym(date);
  const { start, end } = monthBounds(date);
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${parent}_${tag} PARTITION OF ${parent} ` +
    `FOR VALUES FROM ('${start}') TO ('${end}');`
  );
}
