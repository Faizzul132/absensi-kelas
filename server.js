const express = require('express');
const multer = require('multer');
const path = require('path');
const { db, initDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Multer memory storage configuration for letters/photos (avoids read-only disk issues on serverless/Vercel)
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static HTML/CSS/Images files from workspace root
app.use(express.static(__dirname));

// Start DB initialization
const dbInitPromise = initDb();

// Middleware to ensure DB is initialized before processing any API requests
app.use('/api', async (req, res, next) => {
  try {
    await dbInitPromise;
    next();
  } catch (err) {
    console.error('Database initialization failed:', err);
    res.status(500).json({ success: false, message: 'Database initialization failed. Please check backend logs.' });
  }
});

// API 1: Login/Validation
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
        console.error('Database query error:', err);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
      }

      if (!student) {
        return res.status(401).json({ success: false, message: 'NISN atau Password salah.' });
      }

      // Success
      return res.json({
        success: true,
        student: {
          nisn: student.nisn,
          nama: student.nama,
          kelas: student.kelas
        }
      });
    }
  );
});

// API 2: Standard Attendance (for Hadir - no file)
app.post('/api/attendance', (req, res) => {
  const { nisn, email, nama, kehadiran, alasan } = req.body;

  if (!nisn || !kehadiran) {
    return res.status(400).json({ success: false, message: 'NISN dan status kehadiran wajib.' });
  }

  db.run(
    `INSERT INTO attendance (nisn, email, nama, kehadiran, alasan) 
     VALUES (?, ?, ?, ?, ?)`,
    [nisn, email, nama, kehadiran, alasan || ''],
    function(err) {
      if (err) {
        console.error('Failed to save attendance:', err);
        return res.status(500).json({ success: false, message: 'Gagal menyimpan data kehadiran.' });
      }
      res.json({ success: true, id: this.lastID });
    }
  );
});

// API 3: Attendance with File Upload (for Sakit / Izin)
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
    // Read the uploaded file directly from memory buffer
    const fileData = file.buffer;

    db.run(
      `INSERT INTO attendance (nisn, email, nama, kehadiran, alasan, surat_filename, surat_mime, surat_data) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [nisn, email, nama, kehadiran, alasan || '', file.originalname, file.mimetype, fileData],
      function(err) {
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

// API 4: Stream letter image from SQLite database
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

// API 5: Retrieve all attendance records (shared or for monitoring)
app.get('/api/attendance', (req, res) => {
  db.all('SELECT id, nisn, email, nama, kehadiran, alasan, surat_filename, created_at FROM attendance ORDER BY created_at DESC', (err, rows) => {
    if (err) {
      console.error('Failed to query attendance:', err);
      return res.status(500).json({ success: false, message: 'Gagal mengambil data.' });
    }
    res.json(rows);
  });
});

// Export app for serverless deployment (Vercel), or listen if run directly
if (require.main === module) {
  dbInitPromise
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Student attendance app is running locally at http://localhost:${PORT}`);
      });
    })
    .catch((err) => {
      console.error('Failed to initialize database:', err);
      process.exit(1);
    });
} else {
  module.exports = app;
}
