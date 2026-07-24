// One-off script to apply prisma/migrations/*/migration.sql directly via
// `pg`, bypassing Prisma's native schema-engine binary (blocked on this
// machine by Windows Smart App Control — see backend/CLAUDE.md).
//
// After applying the SQL, this also bootstraps Prisma's own
// `_prisma_migrations` tracking table and inserts a row marking the
// migration as applied, using the same checksum algorithm Prisma's CLI
// uses (SHA-256 of the migration.sql file). This means a normal
// `prisma migrate deploy` run later (e.g. on Railway, which is Linux and
// unaffected by Smart App Control) will see this migration as already
// applied and won't try to re-run it against tables that already exist.
//
// Usage: node scripts/apply-baseline-migration.js <migration-folder-name>
// Example: node scripts/apply-baseline-migration.js 20260724142555_init_schema_v1_5

require('dotenv/config');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');

async function main() {
  const migrationName = process.argv[2];
  if (!migrationName) {
    console.error('Usage: node scripts/apply-baseline-migration.js <migration-folder-name>');
    process.exit(1);
  }

  const migrationDir = path.join(__dirname, '..', 'prisma', 'migrations', migrationName);
  const sqlPath = path.join(migrationDir, 'migration.sql');
  if (!fs.existsSync(sqlPath)) {
    console.error(`Migration file not found: ${sqlPath}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(sqlPath, 'utf8');
  const checksum = crypto.createHash('sha256').update(sql, 'utf8').digest('hex');

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    console.log(`Applying ${migrationName} ...`);
    await client.query(sql);
    console.log('Migration SQL applied successfully.');

    await client.query(`
      create table if not exists "_prisma_migrations" (
        "id" varchar(36) not null,
        "checksum" varchar(64) not null,
        "finished_at" timestamptz,
        "migration_name" varchar(255) not null,
        "logs" text,
        "rolled_back_at" timestamptz,
        "started_at" timestamptz not null default now(),
        "applied_steps_count" integer not null default 0,
        constraint "_prisma_migrations_pkey" primary key ("id")
      );
    `);

    const id = crypto.randomUUID();
    await client.query(
      `insert into "_prisma_migrations"
         (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
       values ($1, $2, now(), $3, now(), 1)`,
      [id, checksum, migrationName],
    );
    console.log(`Recorded ${migrationName} in _prisma_migrations (checksum ${checksum}).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Failed to apply migration:', err);
  process.exit(1);
});
