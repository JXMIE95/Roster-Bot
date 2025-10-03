// src/db/init.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pg from 'pg';

const { Client } = pg;

async function main() {
  const schemaPath = path.join(process.cwd(), 'src', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway')
      ? { rejectUnauthorized: false }
      : undefined,
  });

  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('DB schema applied successfully ✅');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('DB init failed ❌', e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();