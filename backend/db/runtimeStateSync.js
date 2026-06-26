'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const workerPath = path.join(__dirname, 'runtimeStateWorker.js');

function runWorker(command, payload) {
  const options = {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    encoding: 'utf8',
  };

  if (payload !== undefined) {
    options.input = JSON.stringify(payload);
  }

  const result = spawnSync(process.execPath, [workerPath, command], options);
  if (result.error) throw result.error;

  const stdout = (result.stdout || '').trim();
  if (!stdout) {
    throw new Error(result.stderr || `runtime worker returned empty output for "${command}"`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`runtime worker JSON parse failed: ${error.message} :: ${stdout}`);
  }

  if (!parsed.ok) {
    throw new Error(parsed.error || `runtime worker command "${command}" failed`);
  }
  return parsed;
}

function getRuntimeStateSync() {
  return runWorker('get');
}

function setRuntimeStateSync(db, options = {}) {
  return runWorker('set', {
    db,
    skipVersionCheck: !!options.skipVersionCheck,
  });
}

function getRuntimeStatusSync() {
  return runWorker('status');
}

module.exports = {
  getRuntimeStateSync,
  setRuntimeStateSync,
  getRuntimeStatusSync,
};
