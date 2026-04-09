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
const https = require('https');
const http = require('http');

// Google Apps Script redirect-safe fetch
function fetchGoogleScript(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        return fetchGoogleScript(resp.headers.location, maxRedirects - 1).then(resolve).catch(reject);
      }
      let body = '';
      resp.on('data', chunk => body += chunk);
      resp.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Invalid JSON: ' + body.substring(0, 200)));
        }
      });
    }).on('error', reject);
  });
}
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
const HUB_SECRET = process.env.LEADER_REVIEW_HUB_SECRET || 'tcc-hub-2025';

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

      CREATE TABLE IF NOT EXISTS quarterly_reviews (
        id SERIAL PRIMARY KEY,
        director VARCHAR(50) NOT NULL,
        quarter VARCHAR(10) NOT NULL,
        strengths_narrative TEXT,
        focus_areas TEXT,
        goals JSONB,
        metrics_snapshot JSONB,
        director_feedback TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(director, quarter)
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
    const data = await fetchGoogleScript(APPS_SCRIPT_URL);
    res.json(data);
  } catch (err) {
    console.error('Error fetching report data:', err);
    res.json({ success: false, error: err.message });
  }
});

// Debug endpoint — visit /api/debug?director=kirsten&quarter=1&year=2026
app.get('/api/debug', async (req, res) => {
  try {
    const data = await fetchGoogleScript(APPS_SCRIPT_URL);
    
    const dirKey = req.query.director || 'kirsten';
    const quarter = parseInt(req.query.quarter) || 1;
    const year = parseInt(req.query.year) || 2026;
    
    const directors = {
      kirsten: { center: 'Niles', location: 'Niles' },
      gabby: { center: 'Peace Boulevard', location: 'Peace' },
      shari: { center: 'Montessori', location: 'Montessori' }
    };
    const dir = directors[dirKey];
    
    // Parse rows into objects
    const headers = data.headers || [];
    const rows = (data.rows || []).map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] || ''; });
      return obj;
    });
    
    // Get Program Location values
    const allLocations = rows.map(r => r['Program Location']).filter(Boolean);
    const uniqueLocations = [...new Set(allLocations)];
    
    // Filter by director
    const dirRows = rows.filter(row => {
      const loc = String(row['Program Location'] || '').toLowerCase();
      return loc.includes(dir.center.toLowerCase()) || loc.includes(dir.location.toLowerCase());
    });
    
    // Filter by quarter
    const startMonth = (quarter - 1) * 3 + 1;
    const qMonths = [startMonth, startMonth + 1, startMonth + 2];
    const qRows = dirRows.filter(row => {
      const ts = row['Timestamp'] || '';
      const d = new Date(ts);
      if (isNaN(d)) return false;
      return qMonths.includes(d.getMonth() + 1) && d.getFullYear() === year;
    });
    
    res.json({
      totalApiRows: data.rows ? data.rows.length : 0,
      headers: headers.slice(0, 5),
      uniqueLocations,
      directorConfig: dir,
      directorFilteredCount: dirRows.length,
      quarterFilteredCount: qRows.length,
      complianceRowCount: data.compliance ? data.compliance.length : 'no compliance key',
      sampleRow: qRows.length > 0 ? Object.fromEntries(Object.entries(qRows[0]).slice(0, 6)) : 'no rows found',
      allTimestampsForDirector: dirRows.map(r => r['Timestamp']).slice(0, 10)
    });
  } catch (err) {
    res.json({ error: err.message });
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
//  API: Attendance & Ledger Upload & Processing
// ============================================================
const uploadFields = upload.fields([
  { name: 'attendance', maxCount: 1 },
  { name: 'ledger', maxCount: 1 }
]);

app.post('/api/attendance/upload', uploadFields, async (req, res) => {
  try {
    const attFile = req.files && req.files['attendance'] && req.files['attendance'][0];
    const ledgerFile = req.files && req.files['ledger'] && req.files['ledger'][0];

    if (!attFile) return res.json({ success: false, error: 'No attendance file uploaded' });

    const { director, center } = req.body;

    // --- PARSE LEDGER (if provided) to build GSRP roster ---
    const gsrpChildren = new Set();
    if (ledgerFile) {
      const ledgerText = ledgerFile.buffer.toString('utf-8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
      const ledgerRecords = parse(ledgerText, { columns: true, skip_empty_lines: true, relax_column_count: true });
      for (const row of ledgerRecords) {
        const name = (row['name'] || '').trim();
        const item = (row['itemName'] || '').trim();
        if (name && item.toLowerCase().includes('gsrp')) {
          gsrpChildren.add(name.toLowerCase());
        }
      }
    }

    // --- PARSE ATTENDANCE ---
    const csvText = attFile.buffer.toString('utf-8').replace(/^\uFEFF/, '');
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

    // Build a DOB lookup for age-based classroom assignment
    const childDOB = {};
    for (const row of records) {
      const name = (row['Name'] || '').trim();
      const dob = (row['Date of birth'] || '').trim();
      if (name && dob && !childDOB[name]) {
        childDOB[name] = dob;
      }
    }

    // Assign classroom by age when "No Classroom" or empty
    function assignClassroomByAge(name, attendanceDate) {
      const dob = childDOB[name];
      if (!dob) return 'Multi-Age';
      
      // Parse DOB — format is like "March 10, 2022" or "3/10/2022"
      let dobDate;
      if (dob.includes(',')) {
        dobDate = new Date(dob);
      } else {
        const parts = dob.split('/');
        if (parts.length === 3) {
          dobDate = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
        } else {
          dobDate = new Date(dob);
        }
      }
      if (isNaN(dobDate)) return 'Multi-Age';

      // Parse attendance date (M/D/YYYY)
      let attDate;
      const attParts = attendanceDate.split('/');
      if (attParts.length === 3) {
        attDate = new Date(parseInt(attParts[2]), parseInt(attParts[0]) - 1, parseInt(attParts[1]));
      } else {
        attDate = new Date(attendanceDate);
      }
      if (isNaN(attDate)) return 'Multi-Age';

      // Calculate age in months
      const ageMonths = (attDate.getFullYear() - dobDate.getFullYear()) * 12 + (attDate.getMonth() - dobDate.getMonth());
      const ageYears = ageMonths / 12;

      if (ageMonths < 18) return 'Infants/Ones';
      if (ageMonths < 30) return 'Younger Toddlers';  // 18 months to 2.5 years
      if (ageYears >= 5) return 'School-Age';
      return 'Multi-Age';  // 2.5 to 5, not in GSRP/Strong Beginnings
    }

    // Process by month
    const monthlyData = {};

    for (const row of records) {
      const dateStr = (row['Date'] || '').trim();
      const name = (row['Name'] || '').trim();
      let classroom = (row['Check in classroom'] || '').trim();

      // If no classroom assigned, determine by age
      if (!classroom || classroom === 'No classroom') {
        classroom = assignClassroomByAge(name, dateStr);
      }

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

    // Categorize child into 3 enrollment groups
    // GSRP is determined by the ledger (billing items), NOT by classroom name
    function categorizeChild(childName) {
      // Check ledger first — this is the definitive GSRP source
      if (gsrpChildren.size > 0 && gsrpChildren.has((childName || '').toLowerCase())) {
        return 'GSRP';
      }

      // If no ledger uploaded, fall back to classroom name for GSRP detection
      if (gsrpChildren.size === 0) {
        const cls = (childDOB[childName] ? '' : '').toLowerCase(); // no fallback without ledger
        // Without a ledger we can't determine GSRP, so put in age-based category
      }

      // Age-based categorization for non-GSRP children
      const dob = childDOB[childName];
      if (dob) {
        let dobDate;
        if (dob.includes(',')) {
          dobDate = new Date(dob);
        } else {
          const parts = dob.split('/');
          if (parts.length === 3) dobDate = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
          else dobDate = new Date(dob);
        }
        if (!isNaN(dobDate)) {
          const now = new Date();
          const ageMonths = (now.getFullYear() - dobDate.getFullYear()) * 12 + (now.getMonth() - dobDate.getMonth());
          if (ageMonths < 30) return 'Under 2½';
        }
      }

      return 'Over 2½ Private Pay';
    }

    // Save each month to database
    const results = [];
    for (const [monthKey, data] of Object.entries(monthlyData)) {
      const totalChildren = Object.keys(data.childDays).length;
      const children6plus = Object.entries(data.childDays)
        .filter(([_, days]) => days.size >= 6).length;

      // Classroom breakdown for 6+ day children — using 3 categories
      const classroomCounts = {};
      for (const [name, days] of Object.entries(data.childDays)) {
        if (days.size >= 6) {
          const cls = data.childClassroom[name] || '';
          const category = categorizeChild(name);
          classroomCounts[category] = (classroomCounts[category] || 0) + 1;
        }
      }

      // Summary with all children day counts
      const rawSummary = {};
      for (const [name, days] of Object.entries(data.childDays)) {
        rawSummary[name] = { days: days.size, classroom: data.childClassroom[name], category: categorizeChild(name) };
      }

      await pool.query(`
        INSERT INTO attendance_uploads (director, center, upload_month, filename, total_children, children_6plus, classroom_breakdown, raw_summary)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (center, upload_month)
        DO UPDATE SET director = $1, filename = $4, total_children = $5, children_6plus = $6, classroom_breakdown = $7, raw_summary = $8, uploaded_at = NOW()
      `, [director, center, monthKey, attFile.originalname, totalChildren, children6plus, JSON.stringify(classroomCounts), JSON.stringify(rawSummary)]);

      results.push({ month: monthKey, totalChildren, children6plus, classrooms: classroomCounts });
    }

    // === AUTO-POPULATE ENROLLMENT from attendance data ===
    // Group all months by quarter and compute enrollment numbers
    const quarterGroups = {};
    for (const [monthKey, data] of Object.entries(monthlyData)) {
      const [yr, mn] = monthKey.split('-').map(Number);
      const q = Math.ceil(mn / 3);
      const qKey = `Q${q} ${yr}`;
      if (!quarterGroups[qKey]) {
        quarterGroups[qKey] = { childDays: {}, childClassroom: {} };
      }
      // Merge child days across months in the same quarter
      for (const [name, days] of Object.entries(data.childDays)) {
        if (!quarterGroups[qKey].childDays[name]) {
          quarterGroups[qKey].childDays[name] = new Set();
        }
        days.forEach(d => quarterGroups[qKey].childDays[name].add(d));
        // Keep the most recent classroom assignment
        quarterGroups[qKey].childClassroom[name] = data.childClassroom[name];
      }
    }

    // For each quarter found in the upload, calculate and save enrollment
    const enrollmentResults = [];
    for (const [qKey, qData] of Object.entries(quarterGroups)) {
      // Children who attended more than 3 days in the quarter = enrolled
      const enrolledChildren = Object.entries(qData.childDays)
        .filter(([_, days]) => days.size > 3);
      
      const totalEnrolled = enrolledChildren.length;
      let gsrpEnrolled = 0;
      let nonGsrpEnrolled = 0;

      for (const [name, _] of enrolledChildren) {
        const cls = qData.childClassroom[name] || '';
        const category = categorizeChild(name);
        if (category === 'GSRP') {
          gsrpEnrolled++;
        } else {
          nonGsrpEnrolled++;
        }
      }

      // Save to enrollment_data
      await pool.query(`
        INSERT INTO enrollment_data (director, quarter, total_enrolled, non_gsrp_enrolled, gsrp_enrolled, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (director, quarter)
        DO UPDATE SET total_enrolled = $3, non_gsrp_enrolled = $4, gsrp_enrolled = $5, updated_at = NOW()
      `, [director, qKey, totalEnrolled, nonGsrpEnrolled, gsrpEnrolled]);

      enrollmentResults.push({ quarter: qKey, totalEnrolled, gsrpEnrolled, nonGsrpEnrolled });
    }

    res.json({ success: true, months: results, enrollment: enrollmentResults });
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
//  API: Quarterly Reviews (save/load narratives and goals)
// ============================================================
app.get('/api/reviews/:director', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM quarterly_reviews WHERE director = $1 ORDER BY quarter DESC',
      [req.params.director]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/reviews/:director/:quarter', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM quarterly_reviews WHERE director = $1 AND quarter = $2',
      [req.params.director, req.params.quarter]
    );
    res.json({ success: true, data: rows[0] || null });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/reviews', async (req, res) => {
  const { director, quarter, strengths_narrative, focus_areas, goals, metrics_snapshot, director_feedback, director_response } = req.body;
  try {
    // Add columns if they don't exist (for existing databases)
    await pool.query(`ALTER TABLE quarterly_reviews ADD COLUMN IF NOT EXISTS director_feedback TEXT`).catch(() => {});
    await pool.query(`ALTER TABLE quarterly_reviews ADD COLUMN IF NOT EXISTS director_response JSONB`).catch(() => {});
    
    // Merge director_response into goals for backward compatibility
    const mergedGoals = Object.assign({}, goals || {});
    if (director_response) mergedGoals.director_response = director_response;
    
    await pool.query(`
      INSERT INTO quarterly_reviews (director, quarter, strengths_narrative, focus_areas, goals, metrics_snapshot, director_feedback, director_response, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (director, quarter)
      DO UPDATE SET strengths_narrative = $3, focus_areas = $4, goals = $5, metrics_snapshot = $6, director_feedback = $7, director_response = $8, updated_at = NOW()
    `, [director, quarter, strengths_narrative || '', focus_areas || '', JSON.stringify(mergedGoals), JSON.stringify(metrics_snapshot || {}), director_feedback || '', JSON.stringify(director_response || {})]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ============================================================
//  API: Signed Review Uploads
// ============================================================
const signedUpload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
    cb(null, allowed.includes(file.mimetype));
  }
});

app.post('/api/signed-review/upload', signedUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.json({ success: false, error: 'No file uploaded' });
    const { director, quarter } = req.body;
    
    // Create table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS signed_reviews (
        id SERIAL PRIMARY KEY,
        director VARCHAR(50) NOT NULL,
        quarter VARCHAR(10) NOT NULL,
        filename VARCHAR(255),
        mimetype VARCHAR(100),
        filedata BYTEA,
        uploaded_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(director, quarter)
      )
    `);
    
    await pool.query(`
      INSERT INTO signed_reviews (director, quarter, filename, mimetype, filedata, uploaded_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (director, quarter)
      DO UPDATE SET filename = $3, mimetype = $4, filedata = $5, uploaded_at = NOW()
    `, [director, quarter, req.file.originalname, req.file.mimetype, req.file.buffer]);
    
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/signed-review/:director/:quarter', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, director, quarter, filename, mimetype, uploaded_at FROM signed_reviews WHERE director = $1 AND quarter = $2',
      [req.params.director, req.params.quarter]
    );
    res.json({ success: true, data: rows[0] || null });
  } catch (err) {
    res.json({ success: false, data: null });
  }
});

app.get('/api/signed-review/:director/:quarter/download', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT filename, mimetype, filedata FROM signed_reviews WHERE director = $1 AND quarter = $2',
      [req.params.director, req.params.quarter]
    );
    if (!rows[0]) return res.status(404).send('Not found');
    res.set('Content-Type', rows[0].mimetype);
    res.set('Content-Disposition', 'inline; filename="' + rows[0].filename + '"');
    res.send(rows[0].filedata);
  } catch (err) {
    res.status(500).send('Error');
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
