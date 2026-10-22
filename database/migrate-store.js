'use strict';

/**
 * One-time migration script: copies data from data/store.json into PostgreSQL.
 * Run:  node database/migrate-store.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Database, pool } = require('./db');

async function main() {
  const storeFile = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'store.json');

  if (!fs.existsSync(storeFile)) {
    console.error(`[migrate] Store file not found: ${storeFile}`);
    process.exit(1);
  }

  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  console.log('[migrate] Loaded store.json');

  const db = new Database();
  await db.health();
  console.log('[migrate] PostgreSQL connection OK');

  const result = await db.migrateFromStore(store);
  console.log('[migrate] Migration complete:', result);
  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] Fatal:', err);
  process.exit(1);
});
