const express = require('express');
const multer = require('multer');
const path = require('path');
const { db, initDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Multer: memory storage (serverless-safe)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from project root (HTML, CSS, images)
app.use(express.static(path.join(__dirname)));

// Initialize DB
const dbInitPromise = initDb().catch(err => {
  console.error('DB init failed:', err);
});

// Ensure DB ready before all API calls
app.use('/api', async (req, res, next) => {
  try {
    await dbInitPromise;
    next();
  } catch (err) {
    console.error('Database initialization failed:', err);
    res.status(500).json({ success: false, message: 'Database initialization failed.' });
  }
});

// Health check endpoint (for verification on Railway)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    database: process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite',
    timestamp: new Date().toISOString()
  });
});

// ── API 1: Login ──────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { email, nisn, password } = req.body;

  if (!nisn || !password) {
    return res.status(400).json({ success: false, message: 'NISN dan password wajib diisi.' });
  }

  const cleanNisn = nisn.toString().trim();
  const cleanPassword = password.toString().trim();

  db.get(
    'SELECT * FROM students WHERE nisn = ? AND password = ?',
    [cleanNisn, cleanPassword],
    (err, student) => {
      if (err) {
        console.error('DB query error:', err);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
      }
      if (!student) {
        return res.status(401).json({ success: false, message: 'NISN atau Password salah.' });
      }
      return res.json({
        success: true,
        student: { nisn: student.nisn, nama: student.nama, kelas: student.kelas }
      });
    }
  );
});

// ── API 2: Attendance (Hadir) ─────────────────────────────────────────────────
app.post('/api/attendance', (req, res) => {
  const { nisn, email, nama, kehadiran, alasan } = req.body;

  if (!nisn || !kehadiran) {
    return res.status(400).json({ success: false, message: 'NISN dan status kehadiran wajib.' });
  }

  db.run(
    `INSERT INTO attendance (nisn, email, nama, kehadiran, alasan) VALUES (?, ?, ?, ?, ?)`,
    [nisn, email, nama, kehadiran, alasan || ''],
    function (err) {
      if (err) {
        console.error('Failed to save attendance:', err);
        return res.status(500).json({ success: false, message: 'Gagal menyimpan data kehadiran.' });
      }
      res.json({ success: true, id: this.lastID });
    }
  );
});

// ── API 3: Attendance with File (Sakit/Izin) ──────────────────────────────────
app.post('/api/attendance-with-file', upload.single('surat'), (req, res) => {
  const { nisn, email, nama, kehadiran, alasan } = req.body;
  const file = req.file;

  if (!nisn || !kehadiran) {
    return res.status(400).json({ success: false, message: 'NISN dan status kehadiran wajib.' });
  }
  if (!file) {
    return res.status(400).json({ success: false, message: 'Surat bukti (gambar) wajib diupload.' });
  }

  try {
    const fileData = file.buffer;

    db.run(
      `INSERT INTO attendance (nisn, email, nama, kehadiran, alasan, surat_filename, surat_mime, surat_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [nisn, email, nama, kehadiran, alasan || '', file.originalname, file.mimetype, fileData],
      function (err) {
        if (err) {
          console.error('Failed to save attendance with file:', err);
          return res.status(500).json({ success: false, message: 'Gagal menyimpan data kehadiran.' });
        }
        res.json({ success: true, id: this.lastID });
      }
    );
  } catch (err) {
    console.error('File buffer error:', err);
    res.status(500).json({ success: false, message: 'Gagal memproses file upload.' });
  }
});

// ── API 4: Stream surat image ─────────────────────────────────────────────────
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

// ── API 5: Get all attendance records ─────────────────────────────────────────
app.get('/api/attendance', (req, res) => {
  db.all(
    'SELECT id, nisn, email, nama, kehadiran, alasan, surat_filename, created_at FROM attendance ORDER BY created_at DESC',
    (err, rows) => {
      if (err) {
        console.error('Failed to query attendance:', err);
        return res.status(500).json({ success: false, message: 'Gagal mengambil data.' });
      }
      res.json(rows);
    }
  );
});

// ── Monitor dashboard route ───────────────────────────────────────────────────
app.get('/monitor', (req, res) => {
  res.sendFile(path.join(__dirname, 'monitor.html'));
});

// Start server (local dev only)
dbInitPromise.then(() => {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Monitor dashboard: http://localhost:${PORT}/monitor`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
