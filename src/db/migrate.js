import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config.js';
import { closePool, getPool } from './client.js';

const MIGRATION_LOCK_ID = 424242;
const migrationsDir = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const schemaName = config.databaseSchema;
const schemaIdentifier = `"${schemaName}"`;
const migrationsTableName = `${schemaIdentifier}.schema_migrations`;

async function ensureSchema(client) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaIdentifier}`);
}

async function ensureMigrationsTable(client) {
  await ensureSchema(client);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${migrationsTableName} (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  if (schemaName !== 'public') {
    await client.query(`
      INSERT INTO ${migrationsTableName} (version, applied_at)
      SELECT version, applied_at
      FROM public.schema_migrations
      ON CONFLICT (version) DO NOTHING
    `).catch(() => {});
  }
}

async function getAppliedVersions(client) {
  const result = await client.query(`SELECT version FROM ${migrationsTableName}`);
  return new Set(result.rows.map((row) => row.version));
}

async function getMigrationFiles() {
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
}

async function applyMigration(client, fileName) {
  const filePath = path.join(migrationsDir, fileName);
  const sql = await fs.readFile(filePath, 'utf8');

  await client.query('BEGIN');

  try {
    await client.query(`SET LOCAL search_path TO ${schemaIdentifier}, public`);
    await client.query(sql);
    await client.query(
      `INSERT INTO ${migrationsTableName}(version) VALUES ($1)`,
      [fileName]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function runMigrations() {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await ensureMigrationsTable(client);

    const appliedVersions = await getAppliedVersions(client);
    const migrationFiles = await getMigrationFiles();

    for (const fileName of migrationFiles) {
      if (appliedVersions.has(fileName)) {
        console.log(`Skipping already-applied migration: ${fileName}`);
        continue;
      }

      console.log(`Applying migration: ${fileName}`);
      await applyMigration(client, fileName);
    }

    console.log('Database migrations are up to date.');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

const currentModulePath = fileURLToPath(import.meta.url);

if (process.argv[1] === currentModulePath) {
  runMigrations()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error('Migration failed:', error);
      await closePool().catch(() => {});
      process.exit(1);
    });
}
