const express = require('express');
const path = require('path');
const { db, initDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(express.json());

// Serve monitor.html when accessing the root /
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'monitor.html'));
});

// API 1: Retrieve all attendance records for dashboard table
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

// API 2: Stream letter image from SQLite BLOB database
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

// Export app for serverless deployment (Vercel), or listen if run directly
if (require.main === module) {
  initDb()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Teacher monitoring dashboard is running locally at http://localhost:${PORT}`);
      });
    })
    .catch((err) => {
      console.error('Failed to connect to database:', err);
      process.exit(1);
    });
} else {
  // In serverless environment, database initialization runs on cold start
  initDb().catch((err) => console.error('Database Init Error:', err));
  module.exports = app;
}
