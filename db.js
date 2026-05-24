const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');

const isPostgres = process.env.DATABASE_URL && 
  (process.env.DATABASE_URL.startsWith('postgres://') || process.env.DATABASE_URL.startsWith('postgresql://'));

let dbSQLite;
let dbPostgresPool;

if (isPostgres) {
  console.log('Database configuration: Using PostgreSQL');
  dbPostgresPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for hosting platforms like Neon, Railway, Supabase
  });
} else {
  console.log('Database configuration: Using SQLite');
  const dbPath = path.join(__dirname, 'attendance.db');
  dbSQLite = new sqlite3.Database(dbPath);
}

// Convert SQLite style ? placeholders to Postgres style $1, $2
function convertSql(sql) {
  if (!isPostgres) return sql;
  let index = 1;
  return sql.replace(/\?/g, () => `$${index++}`);
}

// Unified Database Helpers
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    const converted = convertSql(sql);
    if (isPostgres) {
      dbPostgresPool.query(converted, params, (err, res) => {
        if (err) return reject(err);
        resolve({ lastID: res.insertId || null, changes: res.rowCount });
      });
    } else {
      dbSQLite.run(converted, params, function(err) {
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

// Rename helper from dbAll to avoid conflict with standard exports
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

// Create database schema
function initDb() {
  return new Promise(async (resolve, reject) => {
    try {
      // Create students table
      await dbRun(`
        CREATE TABLE IF NOT EXISTS students (
          nisn TEXT PRIMARY KEY,
          nama TEXT,
          password TEXT,
          kelas TEXT
        )
      `);

      // Create attendance table with db-specific types
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
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

async function importExcelData() {
  const row = await dbGet('SELECT COUNT(*) as count FROM students');
  const count = row ? parseInt(row.count) : 0;
  
  if (count > 0) {
    console.log('Students data already exists in database. Skipping import.');
    return;
  }

  console.log('Importing students from Excel...');
  const excelPath = path.join(__dirname, 'Data Siswa X-5 (3).xlsx');
  if (!fs.existsSync(excelPath)) {
    console.warn(`Excel file not found at ${excelPath}. Skipping import.`);
    return;
  }

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
           ON CONFLICT (nisn) DO UPDATE SET nama = ?, password = ?, kelas = ?`,
          [nisn, nama, password, kelas, nama, password, kelas]
        );
      } else {
        await dbRun(
          'INSERT OR REPLACE INTO students (nisn, nama, password, kelas) VALUES (?, ?, ?, ?)',
          [nisn, nama, password, kelas]
        );
      }
    }
  }
  console.log(`Successfully imported student credentials to database.`);
}

module.exports = {
  db: {
    run: (sql, params, cb) => {
      dbRun(sql, params).then(res => cb(null, res)).catch(cb);
    },
    get: (sql, params, cb) => {
      dbGet(sql, params).then(res => cb(null, res)).catch(cb);
    },
    all: (sql, params, cb) => {
      // Allow arity with 2 arguments (sql, cb)
      const callback = typeof params === 'function' ? params : cb;
      const args = typeof params === 'function' ? [] : params;
      dbAllRows(sql, args).then(res => callback(null, res)).catch(callback);
    }
  },
  initDb
};
