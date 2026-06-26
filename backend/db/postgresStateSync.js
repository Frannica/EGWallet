'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const workerPath = path.join(__dirname, 'postgresStateWorker.js');

function runWorker(command, payload) {
  const options = {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    encoding: 'utf8',
  };
  if (payload !== undefined) options.input = JSON.stringify(payload);

  const result = spawnSync(process.execPath, [workerPath, command], options);
  if (result.error) throw result.error;

  const stdout = (result.stdout || '').trim();
  if (!stdout) throw new Error(result.stderr || `postgres state worker returned empty output for "${command}"`);

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`postgres state worker JSON parse failed: ${error.message} :: ${stdout}`);
  }
  if (!parsed.ok) throw new Error(parsed.error || `postgres state worker command "${command}" failed`);
  return parsed;
}

function getPostgresStateSync() {
  return runWorker('get');
}

function setPostgresStateSync(db, options = {}) {
  return runWorker('set', {
    db,
    skipVersionCheck: !!options.skipVersionCheck,
  });
}

function getPostgresStatusSync() {
  return runWorker('status');
}

module.exports = {
  getPostgresStateSync,
  setPostgresStateSync,
  getPostgresStatusSync,
};
