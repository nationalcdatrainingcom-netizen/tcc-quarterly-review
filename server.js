// ============================================================
//  TCC QUARTERLY DIRECTOR REVIEW — Server
//  Node.js / Express / PostgreSQL
//  Render deployment with TCC Hub SSO
// ============================================================

const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Database ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// --- Middleware ---
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// --- Config ---
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbx2mTbh-DXop6eyN8fIpN-3puI9BM3-osSwjMT20C4-gVg_psXEGe-jBUir3KQxzqQ/exec';
const HUB_SECRET = process.env.HUB_SECRET || 'tcc-hub-2025';

// Directors config
const DIRECTORS = {
  'kirsten': { name: 'Kirsten', location: 'Niles', center: 'Niles' },
  'gabby':   { name: 'Gabby',   location: 'Peace', center: 'Peace Boulevard' },
  'shari':   { name: 'Shari',   location: 'Montessori', center: 'Montessori' }
};

// ============================================================
//  DATABASE INIT
// ============================================================
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS enrollment_data (
        id SERIAL PRIMARY KEY,
        director VARCHAR(50) NOT NULL,
        quarter VARCHAR(10) NOT NULL,
        total_enrolled INTEGER,
        non_gsrp_enrolled INTEGER,
        gsrp_enrolled INTEGER,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(director, quarter)
      );

      CREATE TABLE IF NOT EXISTS license_data (
        id SERIAL PRIMARY KEY,
        director VARCHAR(50) NOT NULL,
        quarter VARCHAR(10) NOT NULL,
        license_expiry VARCHAR(20),
        quality_level VARCHAR(10),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(director, quarter)
      );

      CREATE TABLE IF NOT EXISTS attendance_uploads (
        id SERIAL PRIMARY KEY,
        director VARCHAR(50) NOT NULL,
        center VARCHAR(100) NOT NULL,
        upload_month VARCHAR(10) NOT NULL,
        filename VARCHAR(255),
        total_children INTEGER,
        children_6plus INTEGER,
        classroom_breakdown JSONB,
        raw_summary JSONB,
        uploaded_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(center, upload_month)
      );
    `);
    console.log('Database tables initialized');
  } finally {
    client.release();
  }
}

// ============================================================
//  SSO — TCC Hub Integration
// ============================================================
app.get('/sso', (req, res) => {
  const { token, user, role, center } = req.query;
  if (token !== HUB_SECRET) {
    return res.status(403).send('Invalid SSO token');
  }
  // Redirect to main page with user info encoded
  const params = new URLSearchParams({ user: user || '', role: role || '', center: center || '' });
  res.redirect('/?' + params.toString());
});

// ============================================================
//  API: Fetch Friday Director Report data from Apps Script
// ============================================================
app.get('/api/report-data', async (req, res) => {
  try {
    const response = await fetch(APPS_SCRIPT_URL, { redirect: 'follow' });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Error fetching report data:', err);
    res.json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: Enrollment CRUD
// ============================================================
app.get('/api/enrollment/:director', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM enrollment_data WHERE director = $1 ORDER BY quarter',
      [req.params.director]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/enrollment', async (req, res) => {
  const { director, quarter, total_enrolled, non_gsrp_enrolled, gsrp_enrolled } = req.body;
  try {
    await pool.query(`
      INSERT INTO enrollment_data (director, quarter, total_enrolled, non_gsrp_enrolled, gsrp_enrolled, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (director, quarter) 
      DO UPDATE SET total_enrolled = $3, non_gsrp_enrolled = $4, gsrp_enrolled = $5, updated_at = NOW()
    `, [director, quarter, total_enrolled || 0, non_gsrp_enrolled || 0, gsrp_enrolled || 0]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: License & Quality CRUD
// ============================================================
app.get('/api/license/:director', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM license_data WHERE director = $1 ORDER BY quarter',
      [req.params.director]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/license', async (req, res) => {
  const { director, quarter, license_expiry, quality_level } = req.body;
  try {
    await pool.query(`
      INSERT INTO license_data (director, quarter, license_expiry, quality_level, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (director, quarter) 
      DO UPDATE SET license_expiry = $3, quality_level = $4, updated_at = NOW()
    `, [director, quarter, license_expiry || '', quality_level || '']);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: Attendance CSV Upload & Processing
// ============================================================
app.post('/api/attendance/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.json({ success: false, error: 'No file uploaded' });

    const { director, center } = req.body;
    const csvText = req.file.buffer.toString('utf-8').replace(/^\uFEFF/, '');
    const lines = csvText.split('\n');

    // Detect Playground CSV format (has school info header row)
    let dataLines = lines;
    let headerIdx = -1;

    for (let i = 0; i < Math.min(10, lines.length); i++) {
      if (lines[i].includes('Name,Last name') || lines[i].includes('Name,"Last name"')) {
        headerIdx = i;
        break;
      }
    }

    if (headerIdx === -1) {
      return res.json({ success: false, error: 'Could not find header row. Make sure this is a Playground attendance export.' });
    }

    // Parse CSV from the header row onward
    const csvContent = lines.slice(headerIdx).join('\n');
    const records = parse(csvContent, { columns: true, skip_empty_lines: true, relax_column_count: true });

    // Process by month
    const monthlyData = {};

    for (const row of records) {
      const dateStr = (row['Date'] || '').trim();
      const name = (row['Name'] || '').trim();
      const classroom = (row['Check in classroom'] || '').trim() || 'No Classroom';

      if (!dateStr || !name) continue;

      const parts = dateStr.split('/');
      if (parts.length !== 3) continue;

      const month = parseInt(parts[0]);
      const year = parseInt(parts[2]);
      const monthKey = `${year}-${String(month).padStart(2, '0')}`;

      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = { childDays: {}, childClassroom: {} };
      }

      if (!monthlyData[monthKey].childDays[name]) {
        monthlyData[monthKey].childDays[name] = new Set();
      }
      monthlyData[monthKey].childDays[name].add(dateStr);
      monthlyData[monthKey].childClassroom[name] = classroom;
    }

    // Save each month to database
    const results = [];
    for (const [monthKey, data] of Object.entries(monthlyData)) {
      const totalChildren = Object.keys(data.childDays).length;
      const children6plus = Object.entries(data.childDays)
        .filter(([_, days]) => days.size >= 6).length;

      // Classroom breakdown for 6+ day children
      const classroomCounts = {};
      for (const [name, days] of Object.entries(data.childDays)) {
        if (days.size >= 6) {
          const cls = data.childClassroom[name] || 'No Classroom';
          classroomCounts[cls] = (classroomCounts[cls] || 0) + 1;
        }
      }

      // Summary with all children day counts
      const rawSummary = {};
      for (const [name, days] of Object.entries(data.childDays)) {
        rawSummary[name] = { days: days.size, classroom: data.childClassroom[name] };
      }

      await pool.query(`
        INSERT INTO attendance_uploads (director, center, upload_month, filename, total_children, children_6plus, classroom_breakdown, raw_summary)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (center, upload_month)
        DO UPDATE SET director = $1, filename = $4, total_children = $5, children_6plus = $6, classroom_breakdown = $7, raw_summary = $8, uploaded_at = NOW()
      `, [director, center, monthKey, req.file.originalname, totalChildren, children6plus, JSON.stringify(classroomCounts), JSON.stringify(rawSummary)]);

      results.push({ month: monthKey, totalChildren, children6plus, classrooms: classroomCounts });
    }

    res.json({ success: true, months: results });
  } catch (err) {
    console.error('Attendance upload error:', err);
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/attendance/:director', async (req, res) => {
  try {
    const dirConfig = DIRECTORS[req.params.director];
    const centerName = dirConfig ? dirConfig.center : req.params.director;

    const { rows } = await pool.query(
      'SELECT * FROM attendance_uploads WHERE LOWER(center) = LOWER($1) ORDER BY upload_month',
      [centerName]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ============================================================
//  SERVE FRONTEND
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
//  START
// ============================================================
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`TCC Quarterly Review running on port ${PORT}`);
  });
}).catch(err => {
  console.error('DB init failed:', err);
  app.listen(PORT, () => {
    console.log(`TCC Quarterly Review running on port ${PORT} (DB init failed)`);
  });
});
