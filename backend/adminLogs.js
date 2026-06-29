'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { adminAuth, requirePermission } = require('./adminAuth');
const { logAdminAction } = require('./adminAudit');

const router = express.Router();

const ERROR_LOG_PATH = process.env.ERROR_LOG_PATH || path.join(__dirname, 'logs', 'error.log');
const COMBINED_LOG_PATH = process.env.COMBINED_LOG_PATH || path.join(__dirname, 'logs', 'combined.log');

function tailFile(filePath, maxLines = 200) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines).reverse();
}

router.get('/errors', adminAuth, requirePermission('logs:read'), (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const errors = tailFile(ERROR_LOG_PATH, limit);
    const combined = errors.length ? errors : tailFile(COMBINED_LOG_PATH, limit).filter((line) =>
      /error|fatal|exception|fail/i.test(line),
    );
    logAdminAction(req, 'LOGS_VIEW', { type: 'errors', count: combined.length });
    res.json({ logs: combined, count: combined.length, source: errors.length ? ERROR_LOG_PATH : COMBINED_LOG_PATH });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to read system logs' });
  }
});

module.exports = router;
