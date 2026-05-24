const path = require('path');
const fs = require('fs');

// ── Guard: Vercel WAJIB menggunakan PostgreSQL ─────────────────────────────────
if (process.env.VERCEL && !process.env.DATABASE_URL) {
  throw new Error(
    '[FATAL] DATABASE_URL belum diset di Vercel!\n' +
    '1. Buka https://neon.tech → buat project gratis\n' +
    '2. Copy connection string PostgreSQL-nya\n' +
    '3. Buka Vercel Dashboard → project → Settings → Environment Variables\n' +
    '4. Tambah: NAME=DATABASE_URL, VALUE=<connection string neon>\n' +
    '5. Redeploy'
  );
}

const isPostgres = !!(process.env.DATABASE_URL &&
  (process.env.DATABASE_URL.startsWith('postgres://') ||
   process.env.DATABASE_URL.startsWith('postgresql://')));

let dbSQLite = null;
let dbPostgresPool = null;

if (isPostgres) {
  console.log('[DB] Using PostgreSQL (Neon/Production)');
  const { Pool } = require('pg');
  dbPostgresPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000
  });
} else {
  // Hanya untuk local development (bukan Vercel)
  console.log('[DB] Using SQLite (local dev only)');
  let sqlite3;
  try {
    sqlite3 = require('sqlite3').verbose();
  } catch (e) {
    throw new Error(
      '[FATAL] sqlite3 tidak terinstall. Jalankan: npm install --save-dev sqlite3\n' +
      'Atau set DATABASE_URL untuk menggunakan PostgreSQL.'
    );
  }

  let dbPath = path.join(__dirname, 'attendance.db');

  if (process.env.VERCEL) {
    // Fallback jika somehow VERCEL=true tapi DATABASE_URL ada (edge case)
    const tmpDbPath = '/tmp/attendance.db';
    try {
      if (!fs.existsSync(tmpDbPath) && fs.existsSync(dbPath)) {
        fs.copyFileSync(dbPath, tmpDbPath);
        console.log('[DB] Copied attendance.db to /tmp/');
      }
      dbPath = tmpDbPath;
    } catch (e) {
      console.error('[DB] Failed to copy to /tmp:', e.message);
    }
  }

  dbSQLite = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('[DB] SQLite open error:', err.message);
  });
}

// ── SQL placeholder converter: ? → $1, $2, ... ────────────────────────────────
function convertSql(sql) {
  if (!isPostgres) return sql;
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// ── Promise-based helpers ──────────────────────────────────────────────────────

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    let finalSql = convertSql(sql);
    // Tambah RETURNING id untuk INSERT di Postgres
    if (isPostgres && /^\s*INSERT\s/i.test(finalSql) && !/RETURNING/i.test(finalSql)) {
      finalSql = finalSql.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id';
    }
    if (isPostgres) {
      dbPostgresPool.query(finalSql, params, (err, res) => {
        if (err) return reject(err);
        const lastID = res.rows && res.rows[0] ? res.rows[0].id : null;
        resolve({ lastID, changes: res.rowCount });
      });
    } else {
      dbSQLite.run(finalSql, params, function (err) {
        if (err) return reject(err);
        resolve({ lastID: this.lastID, changes: this.changes });
      });
    }
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    const finalSql = convertSql(sql);
    if (isPostgres) {
      dbPostgresPool.query(finalSql, params, (err, res) => {
        if (err) return reject(err);
        resolve(res.rows[0] || null);
      });
    } else {
      dbSQLite.get(finalSql, params, (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      });
    }
  });
}

function dbAllRows(sql, params = []) {
  return new Promise((resolve, reject) => {
    const finalSql = convertSql(sql);
    if (isPostgres) {
      dbPostgresPool.query(finalSql, params, (err, res) => {
        if (err) return reject(err);
        resolve(res.rows);
      });
    } else {
      dbSQLite.all(finalSql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    }
  });
}

// ── Schema & Seed ──────────────────────────────────────────────────────────────

async function initDb() {
  console.log('[DB] Running initDb...');

  await dbRun(`
    CREATE TABLE IF NOT EXISTS students (
      nisn TEXT PRIMARY KEY,
      nama TEXT,
      password TEXT,
      kelas TEXT
    )
  `);

  const attendanceSql = isPostgres
    ? `CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        nisn TEXT,
        email TEXT,
        nama TEXT,
        kehadiran TEXT,
        alasan TEXT,
        surat_filename TEXT,
        surat_mime TEXT,
        surat_data BYTEA,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
       )`
    : `CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nisn TEXT,
        email TEXT,
        nama TEXT,
        kehadiran TEXT,
        alasan TEXT,
        surat_filename TEXT,
        surat_mime TEXT,
        surat_data BLOB,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
       )`;

  await dbRun(attendanceSql);

  await importExcelData();
  console.log('[DB] initDb complete.');
}

async function importExcelData() {
  let xlsx;
  try {
    xlsx = require('xlsx');
  } catch (e) {
    console.warn('[DB] xlsx not available, skipping Excel import.');
    return;
  }

  const row = await dbGet('SELECT COUNT(*) AS count FROM students');
  const count = row ? parseInt(row.count, 10) : 0;

  if (count > 0) {
    console.log(`[DB] ${count} students already in DB. Skipping Excel import.`);
    return;
  }

  const excelPath = path.join(__dirname, 'Data Siswa X-5 (3).xlsx');
  if (!fs.existsSync(excelPath)) {
    console.warn(`[DB] Excel not found at ${excelPath}. Skipping.`);
    return;
  }

  console.log('[DB] Importing students from Excel...');
  const workbook = xlsx.readFile(excelPath);
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = xlsx.utils.sheet_to_json(worksheet);

  let imported = 0;
  for (const item of data) {
    const nisn     = item['NISN']     ? item['NISN'].toString().trim()     : '';
    const password = item['PASSWORD'] ? item['PASSWORD'].toString().trim() : '';
    const nama     = item['NAMA']     ? item['NAMA'].toString().trim()     : '';
    const kelas    = item['KELAS']    ? item['KELAS'].toString().trim()    : '';

    if (!nisn || !password) continue;

    if (isPostgres) {
      await dbRun(
        `INSERT INTO students (nisn, nama, password, kelas)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (nisn) DO UPDATE
           SET nama = EXCLUDED.nama,
               password = EXCLUDED.password,
               kelas = EXCLUDED.kelas`,
        [nisn, nama, password, kelas]
      );
    } else {
      await dbRun(
        'INSERT OR REPLACE INTO students (nisn, nama, password, kelas) VALUES (?, ?, ?, ?)',
        [nisn, nama, password, kelas]
      );
    }
    imported++;
  }
  console.log(`[DB] Imported ${imported} students.`);
}

// ── Callback-style wrapper ─────────────────────────────────────────────────────

module.exports = {
  db: {
    run: (sql, params, cb) => {
      dbRun(sql, params).then(res => cb(null, res)).catch(cb);
    },
    get: (sql, params, cb) => {
      dbGet(sql, params).then(res => cb(null, res)).catch(cb);
    },
    all: (sql, params, cb) => {
      const callback = typeof params === 'function' ? params : cb;
      const args     = typeof params === 'function' ? []     : params;
      dbAllRows(sql, args).then(res => callback(null, res)).catch(callback);
    }
  },
  initDb
};
