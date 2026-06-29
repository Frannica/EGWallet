'use strict';

const express = require('express');
const { adminAuth, requirePermission, adminCsrf } = require('./adminAuth');
const { getAllAdminSettings, getAdminSetting, upsertAdminSetting } = require('./db/adminPlatformPostgres');
const { logAdminAction } = require('./adminAudit');

const router = express.Router();

router.get('/', adminAuth, requirePermission('settings:read'), async (req, res) => {
  try {
    const settings = await getAllAdminSettings();
    logAdminAction(req, 'SETTINGS_VIEW', {});
    res.json({ settings });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.patch('/', adminAuth, adminCsrf, requirePermission('settings:write'), async (req, res) => {
  try {
    const { maintenanceMode, featureFlags, dailyLimits } = req.body || {};
    const updated = {};

    if (maintenanceMode !== undefined) {
      updated.maintenance_mode = await upsertAdminSetting('maintenance_mode', maintenanceMode, req.admin.id);
    }
    if (featureFlags !== undefined) {
      updated.feature_flags = await upsertAdminSetting('feature_flags', featureFlags, req.admin.id);
    }
    if (dailyLimits !== undefined) {
      updated.daily_limits = await upsertAdminSetting('daily_limits', dailyLimits, req.admin.id);
    }

    logAdminAction(req, 'SETTINGS_UPDATE', { keys: Object.keys(updated) });
    res.json({ settings: updated });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

async function isMaintenanceModeEnabled() {
  try {
    const val = await getAdminSetting('maintenance_mode');
    return val?.enabled === true;
  } catch (_error) {
    return false;
  }
}

module.exports = { router, isMaintenanceModeEnabled };
