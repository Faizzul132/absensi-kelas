const express = require('express');
const { db, initDb } = require('../db');

const app = express();

// Middleware
app.use(express.json());

// Initialize DB once per cold-start
const dbInitPromise = initDb().catch(err => {
  console.error('DB init failed on cold start:', err);
});

// Ensure DB ready before all API calls
app.use(async (req, res, next) => {
  try {
    await dbInitPromise;
    next();
  } catch (err) {
    console.error('Database initialization failed:', err);
    res.status(500).json({ success: false, message: 'Database tidak dapat diinisialisasi.' });
  }
});

// ── API 1: Get all attendance records ─────────────────────────────────────────
app.get('/api/attendance', (req, res) => {
  db.all(
    `SELECT id, nisn, email, nama, kehadiran, alasan, surat_filename, created_at
     FROM attendance
     ORDER BY created_at DESC`,
    (err, rows) => {
      if (err) {
        console.error('Failed to query attendance:', err);
        return res.status(500).json({ success: false, message: 'Gagal mengambil data presensi.' });
      }
      res.json(rows);
    }
  );
});

// ── API 2: Stream surat image ─────────────────────────────────────────────────
app.get('/api/attendance/surat/:id', (req, res) => {
  const { id } = req.params;
  db.get('SELECT surat_mime, surat_data FROM attendance WHERE id = ?', [id], (err, row) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Database error');
    }
    if (!row || !row.surat_data) {
      return res.status(404).send('Gambar surat tidak ditemukan');
    }
    res.contentType(row.surat_mime || 'image/jpeg');
    res.send(row.surat_data);
  });
});

// Export for Vercel serverless
module.exports = app;
