import { Pool } from 'pg';

import { config } from '../config.js';

let pool;

function getSearchPathOptions() {
  return `-c search_path=${config.databaseSchema},public`;
}

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'stallone',
      options: getSearchPathOptions(),
    });
  }

  return pool;
}

export async function withClient(run) {
  const client = await getPool().connect();

  try {
    return await run(client);
  } finally {
    client.release();
  }
}

export async function checkDatabaseConnection() {
  const result = await getPool().query(
    'SELECT NOW() AS server_time, current_database() AS database_name, current_schema() AS schema_name'
  );
  return result.rows[0];
}

export async function closePool() {
  if (!pool) {
    return;
  }

  await pool.end();
  pool = undefined;
}
