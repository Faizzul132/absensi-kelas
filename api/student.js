const express = require('express');
const multer = require('multer');

const app = express();

// Multer: memory storage (tidak tulis ke disk)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── DB Init (satu kali per cold-start) ───────────────────────────────────────
let db, initDb;
let dbInitError = null;
let dbInitPromise;

try {
  const dbModule = require('../db');
  db = dbModule.db;
  initDb = dbModule.initDb;
  dbInitPromise = initDb().catch(err => {
    dbInitError = err;
    console.error('[API] DB init failed:', err.message);
  });
} catch (err) {
  // db.js itself threw (e.g. DATABASE_URL missing on Vercel)
  dbInitError = err;
  dbInitPromise = Promise.resolve();
  console.error('[API] Failed to load db module:', err.message);
}

// ── Middleware: pastikan DB siap ──────────────────────────────────────────────
async function ensureDb(req, res, next) {
  await dbInitPromise;
  if (dbInitError) {
    return res.status(503).json({
      success: false,
      message: 'Database belum dikonfigurasi. Hubungi admin.',
      debug: process.env.NODE_ENV !== 'production' ? dbInitError.message : undefined
    });
  }
  next();
}

// ── Health check (untuk debug di Vercel) ─────────────────────────────────────
app.get('/api/health', async (req, res) => {
  await dbInitPromise;
  if (dbInitError) {
    return res.status(503).json({
      status: 'error',
      message: dbInitError.message,
      hint: 'Pastikan DATABASE_URL sudah diset di Vercel Environment Variables'
    });
  }
  res.json({
    status: 'ok',
    database: process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite',
    timestamp: new Date().toISOString()
  });
});

// ── API 1: Login ──────────────────────────────────────────────────────────────
app.post('/api/login', ensureDb, (req, res) => {
  const { email, nisn, password } = req.body;

  if (!nisn || !password) {
    return res.status(400).json({ success: false, message: 'NISN dan password wajib diisi.' });
  }

  db.get(
    'SELECT * FROM students WHERE nisn = ? AND password = ?',
    [nisn.toString().trim(), password.toString().trim()],
    (err, student) => {
      if (err) {
        console.error('[login] DB error:', err);
        return res.status(500).json({ success: false, message: 'Kesalahan database.' });
      }
      if (!student) {
        return res.status(401).json({ success: false, message: 'NISN atau Password salah.' });
      }
      res.json({
        success: true,
        student: { nisn: student.nisn, nama: student.nama, kelas: student.kelas }
      });
    }
  );
});

// ── API 2: Attendance (Hadir) ─────────────────────────────────────────────────
app.post('/api/attendance', ensureDb, (req, res) => {
  const { nisn, email, nama, kehadiran, alasan } = req.body;

  if (!nisn || !kehadiran) {
    return res.status(400).json({ success: false, message: 'NISN dan status kehadiran wajib.' });
  }

  db.run(
    `INSERT INTO attendance (nisn, email, nama, kehadiran, alasan) VALUES (?, ?, ?, ?, ?)`,
    [nisn, email, nama, kehadiran, alasan || ''],
    function (err) {
      if (err) {
        console.error('[attendance] DB error:', err);
        return res.status(500).json({ success: false, message: 'Gagal menyimpan data kehadiran.' });
      }
      res.json({ success: true, id: this.lastID });
    }
  );
});

// ── API 3: Attendance + File Upload (Sakit/Izin) ──────────────────────────────
app.post('/api/attendance-with-file', ensureDb, upload.single('surat'), (req, res) => {
  const { nisn, email, nama, kehadiran, alasan } = req.body;
  const file = req.file;

  if (!nisn || !kehadiran) {
    return res.status(400).json({ success: false, message: 'NISN dan status kehadiran wajib.' });
  }
  if (!file) {
    return res.status(400).json({ success: false, message: 'Surat bukti wajib diupload.' });
  }

  db.run(
    `INSERT INTO attendance (nisn, email, nama, kehadiran, alasan, surat_filename, surat_mime, surat_data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [nisn, email, nama, kehadiran, alasan || '', file.originalname, file.mimetype, file.buffer],
    function (err) {
      if (err) {
        console.error('[attendance-with-file] DB error:', err);
        return res.status(500).json({ success: false, message: 'Gagal menyimpan data kehadiran.' });
      }
      res.json({ success: true, id: this.lastID });
    }
  );
});

// ── API 4: Stream gambar surat ────────────────────────────────────────────────
app.get('/api/attendance/surat/:id', ensureDb, (req, res) => {
  db.get(
    'SELECT surat_mime, surat_data FROM attendance WHERE id = ?',
    [req.params.id],
    (err, row) => {
      if (err) return res.status(500).send('Database error');
      if (!row || !row.surat_data) return res.status(404).send('Gambar tidak ditemukan');
      res.contentType(row.surat_mime || 'image/jpeg');
      res.send(row.surat_data);
    }
  );
});

// ── API 5: Ambil semua data presensi ──────────────────────────────────────────
app.get('/api/attendance', ensureDb, (req, res) => {
  db.all(
    'SELECT id, nisn, email, nama, kehadiran, alasan, surat_filename, created_at FROM attendance ORDER BY created_at DESC',
    (err, rows) => {
      if (err) {
        console.error('[attendance GET] DB error:', err);
        return res.status(500).json({ success: false, message: 'Gagal mengambil data.' });
      }
      res.json(rows);
    }
  );
});

module.exports = app;
