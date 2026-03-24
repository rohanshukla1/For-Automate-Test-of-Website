const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const { runScan } = require('./src/scanner/orchestrator');
const jobStore = require('./src/jobStore');

// Ensure reports directory exists
fs.mkdirSync(path.join(__dirname, 'reports'), { recursive: true });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve screenshots
app.use('/reports', express.static(path.join(__dirname, 'reports')));

// POST /api/scan - Start a new scan
app.post('/api/scan', async (req, res) => {
  const { url, depth = 2, email, password, cookies, html, localStorageData, sessionStorageData } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A valid URL is required.' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format.' });
  }

  const jobId = uuidv4();
  const job = {
    id: jobId,
    url: parsedUrl.href,
    depth: Math.min(Math.max(parseInt(depth) || 2, 1), 5),
    status: 'queued',
    progress: 0,
    step: 'Queued',
    email: email || null,
    password: password || null,
    cookies: cookies || null,
    html: html || null,
    localStorageData: localStorageData || null,
    sessionStorageData: sessionStorageData || null,
    results: null,
    reportPath: null,
    createdAt: new Date().toISOString(),
  };

  jobStore.clear(); // Purge old jobs from memory
  jobStore.set(jobId, job);

  // Wipe the entire reports directory to prevent disk buildup of old scans
  const reportsDir = path.join(__dirname, 'reports');
  try {
    if (fs.existsSync(reportsDir)) {
      fs.rmSync(reportsDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn('Could not cleanly delete previous reports folder (files might be locked by Windows):', err.message);
  }
  
  // Create fresh report dir for the new job
  const reportDir = path.join(__dirname, 'reports', jobId);
  try {
    fs.mkdirSync(reportDir, { recursive: true });
  } catch(e){}

  // Run scan async
  runScan(jobId).catch((err) => {
    const j = jobStore.get(jobId);
    if (j) {
      j.status = 'failed';
      j.step = `Error: ${err.message}`;
      jobStore.set(jobId, j);
    }
  });

  res.json({ jobId, message: 'Scan started.' });
});

// GET /api/scan/:id/status
app.get('/api/scan/:id/status', (req, res) => {
  const job = jobStore.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    step: job.step,
    url: job.url,
  });
});

// GET /api/scan/:id/report
app.get('/api/scan/:id/report', (req, res) => {
  const job = jobStore.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'complete') {
    return res.status(202).json({ message: 'Scan not yet complete.', status: job.status });
  }
  res.json(job.results);
});

// GET /api/scan/:id/download - Download HTML report
app.get('/api/scan/:id/download', (req, res) => {
  const job = jobStore.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (!job.reportPath || !fs.existsSync(job.reportPath)) {
    return res.status(404).json({ error: 'Report not generated yet.' });
  }
  res.download(job.reportPath, `qa-report-${req.params.id.slice(0, 8)}.html`);
});

app.listen(PORT, () => {
  console.log(`\n🚀 Auto Web QA Scanner running at http://localhost:${PORT}\n`);
});
