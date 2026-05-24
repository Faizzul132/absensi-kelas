const path = require('path');
const fs = require('fs');

const isPostgres = process.env.DATABASE_URL &&
  (process.env.DATABASE_URL.startsWith('postgres://') || process.env.DATABASE_URL.startsWith('postgresql://'));

let dbSQLite;
let dbPostgresPool;

if (isPostgres) {
  console.log('Database configuration: Using PostgreSQL (Neon)');
  const { Pool } = require('pg');
  dbPostgresPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
} else {
  console.log('Database configuration: Using SQLite (local dev)');
  const sqlite3 = require('sqlite3').verbose();
  let dbPath = path.join(__dirname, 'attendance.db');

  // If running on Vercel, use writable /tmp directory
  if (process.env.VERCEL) {
    const tmpDbPath = path.join('/tmp', 'attendance.db');
    try {
      if (!fs.existsSync(tmpDbPath)) {
        if (fs.existsSync(dbPath)) {
          fs.copyFileSync(dbPath, tmpDbPath);
          console.log('Copied attendance.db to /tmp/attendance.db');
        }
      }
      dbPath = tmpDbPath;
    } catch (err) {
      console.error('Failed to prepare writable SQLite database in /tmp:', err);
    }
  }

  dbSQLite = new sqlite3.Database(dbPath);
}

// Convert SQLite ? placeholders to Postgres $1, $2, ...
function convertSql(sql) {
  if (!isPostgres) return sql;
  let index = 1;
  return sql.replace(/\?/g, () => `$${index++}`);
}

// --- Unified DB helpers (Promise-based) ---

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    const converted = convertSql(sql);
    if (isPostgres) {
      dbPostgresPool.query(converted, params, (err, res) => {
        if (err) return reject(err);
        // For INSERT ... RETURNING id
        const lastID = res.rows && res.rows[0] ? res.rows[0].id : null;
        resolve({ lastID, changes: res.rowCount });
      });
    } else {
      dbSQLite.run(converted, params, function (err) {
        if (err) return reject(err);
        resolve({ lastID: this.lastID, changes: this.changes });
      });
    }
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    const converted = convertSql(sql);
    if (isPostgres) {
      dbPostgresPool.query(converted, params, (err, res) => {
        if (err) return reject(err);
        resolve(res.rows[0] || null);
      });
    } else {
      dbSQLite.get(converted, params, (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      });
    }
  });
}

function dbAllRows(sql, params = []) {
  return new Promise((resolve, reject) => {
    const converted = convertSql(sql);
    if (isPostgres) {
      dbPostgresPool.query(converted, params, (err, res) => {
        if (err) return reject(err);
        resolve(res.rows);
      });
    } else {
      dbSQLite.all(converted, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    }
  });
}

// --- Schema Initialization ---

async function initDb() {
  // Create students table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS students (
      nisn TEXT PRIMARY KEY,
      nama TEXT,
      password TEXT,
      kelas TEXT
    )
  `);

  // Create attendance table
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

  // Import Excel data if students table is empty
  await importExcelData();
}

async function importExcelData() {
  // xlsx is optional (not available in production if not installed)
  let xlsx;
  try {
    xlsx = require('xlsx');
  } catch (e) {
    console.warn('xlsx module not found, skipping Excel import.');
    return;
  }

  const row = await dbGet('SELECT COUNT(*) AS count FROM students');
  // Postgres returns count as string, SQLite as number
  const count = row ? parseInt(row.count, 10) : 0;

  if (count > 0) {
    console.log('Students data already exists. Skipping Excel import.');
    return;
  }

  const excelPath = path.join(__dirname, 'Data Siswa X-5 (3).xlsx');
  if (!fs.existsSync(excelPath)) {
    console.warn(`Excel file not found at ${excelPath}. Skipping import.`);
    return;
  }

  console.log('Importing students from Excel...');
  const workbook = xlsx.readFile(excelPath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = xlsx.utils.sheet_to_json(worksheet);

  for (const item of data) {
    const nisn = item['NISN'] ? item['NISN'].toString().trim() : '';
    const password = item['PASSWORD'] ? item['PASSWORD'].toString().trim() : '';
    const nama = item['NAMA'] ? item['NAMA'].toString().trim() : '';
    const kelas = item['KELAS'] ? item['KELAS'].toString().trim() : '';

    if (nisn && password) {
      if (isPostgres) {
        await dbRun(
          `INSERT INTO students (nisn, nama, password, kelas)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (nisn) DO UPDATE SET nama = EXCLUDED.nama, password = EXCLUDED.password, kelas = EXCLUDED.kelas`,
          [nisn, nama, password, kelas]
        );
      } else {
        await dbRun(
          'INSERT OR REPLACE INTO students (nisn, nama, password, kelas) VALUES (?, ?, ?, ?)',
          [nisn, nama, password, kelas]
        );
      }
    }
  }
  console.log('Successfully imported student credentials.');
}

// --- Callback-style wrapper (used by server.js) ---

module.exports = {
  db: {
    run: (sql, params, cb) => {
      // Build correct INSERT ... RETURNING id for postgres
      let finalSql = sql;
      if (isPostgres && /^\s*INSERT/i.test(sql) && !/RETURNING/i.test(sql)) {
        finalSql = sql.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id';
      }
      dbRun(finalSql, params)
        .then(res => cb(null, res))
        .catch(cb);
    },
    get: (sql, params, cb) => {
      dbGet(sql, params)
        .then(res => cb(null, res))
        .catch(cb);
    },
    all: (sql, params, cb) => {
      const callback = typeof params === 'function' ? params : cb;
      const args = typeof params === 'function' ? [] : params;
      dbAllRows(sql, args)
        .then(res => callback(null, res))
        .catch(callback);
    }
  },
  initDb
};
