'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { adminAuth, requirePermission, adminCsrf } = require('./adminAuth');
const { loadAppState, saveAppState } = require('./db/appStateStore');
const { logAdminAction } = require('./adminAudit');

const router = express.Router();

const VALID_TYPES = ['admin_message', 'maintenance', 'announcement'];
const VALID_AUDIENCES = ['user_ids', 'all', 'country', 'kyc_tier', 'account_status'];

function writeUserNotification(db, userId, type, title, body, metadata = {}) {
  if (!db.notifications) db.notifications = [];
  db.notifications.unshift({
    id: uuidv4(),
    userId,
    type,
    title,
    body,
    read: false,
    metadata,
    createdAt: Date.now(),
  });
}

function resolveTargetUserIds(db, criteria) {
  const users = db.users || [];
  const { audience, userIds, country, kycTier, accountStatus } = criteria;

  if (audience === 'user_ids') {
    const ids = Array.isArray(userIds) ? userIds : [];
    return [...new Set(ids.filter((id) => users.some((u) => u.id === id)))];
  }
  if (audience === 'all') {
    return users.map((u) => u.id);
  }
  if (audience === 'country') {
    if (!country) return [];
    return users.filter((u) => u.region === country).map((u) => u.id);
  }
  if (audience === 'kyc_tier') {
    const tier = Number(kycTier);
    if (!Number.isInteger(tier)) return [];
    return users.filter((u) => (u.kycTier || 0) === tier).map((u) => u.id);
  }
  if (audience === 'account_status') {
    if (!accountStatus) return [];
    return users.filter((u) => (u.accountStatus || 'active') === accountStatus).map((u) => u.id);
  }
  return [];
}

router.get('/announcements', adminAuth, requirePermission('notifications:read'), (req, res) => {
  const db = loadAppState();
  const announcements = [...(db.announcements || [])].sort((a, b) => b.createdAt - a.createdAt);
  logAdminAction(req, 'ANNOUNCEMENTS_LIST', { count: announcements.length });
  res.json({ announcements: announcements.slice(0, 100) });
});

router.post('/send', adminAuth, adminCsrf, requirePermission('notifications:write'), (req, res) => {
  const { title, body, type, audience, userIds, country, kycTier, accountStatus } = req.body || {};

  if (!title?.trim() || !body?.trim()) {
    return res.status(400).json({ error: 'title and body are required' });
  }
  const notifType = type || 'admin_message';
  if (!VALID_TYPES.includes(notifType)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
  }
  const targetAudience = audience || (Array.isArray(userIds) && userIds.length ? 'user_ids' : null);
  if (!targetAudience || !VALID_AUDIENCES.includes(targetAudience)) {
    return res.status(400).json({ error: `audience must be one of: ${VALID_AUDIENCES.join(', ')}` });
  }

  const db = loadAppState();
  const targetIds = resolveTargetUserIds(db, {
    audience: targetAudience,
    userIds,
    country,
    kycTier,
    accountStatus,
  });

  if (targetIds.length === 0) {
    return res.status(400).json({ error: 'No users matched the targeting criteria' });
  }

  const metadata = {
    sentBy: req.admin.email,
    audience: targetAudience,
    country: country || null,
    kycTier: kycTier ?? null,
    accountStatus: accountStatus || null,
  };

  for (const userId of targetIds) {
    writeUserNotification(db, userId, notifType, title.trim(), body.trim(), metadata);
  }
  saveAppState(db);

  logAdminAction(req, 'NOTIFICATIONS_SENT', {
    type: notifType,
    audience: targetAudience,
    recipientCount: targetIds.length,
  });

  res.json({ success: true, recipientCount: targetIds.length, type: notifType });
});

router.post('/announcements', adminAuth, adminCsrf, requirePermission('notifications:write'), (req, res) => {
  const { title, body, type, audience, userIds, country, kycTier, accountStatus } = req.body || {};

  if (!title?.trim() || !body?.trim()) {
    return res.status(400).json({ error: 'title and body are required' });
  }
  const announcementType = type === 'maintenance' ? 'maintenance' : 'announcement';
  const targetAudience = audience || 'all';
  if (!VALID_AUDIENCES.includes(targetAudience)) {
    return res.status(400).json({ error: `audience must be one of: ${VALID_AUDIENCES.join(', ')}` });
  }

  const db = loadAppState();
  const targetIds = resolveTargetUserIds(db, {
    audience: targetAudience,
    userIds,
    country,
    kycTier,
    accountStatus,
  });

  if (targetIds.length === 0) {
    return res.status(400).json({ error: 'No users matched the targeting criteria' });
  }

  if (!db.announcements) db.announcements = [];
  const announcement = {
    id: uuidv4(),
    title: title.trim(),
    body: body.trim(),
    type: announcementType,
    audience: targetAudience,
    recipientCount: targetIds.length,
    createdBy: req.admin.email,
    createdAt: Date.now(),
    active: true,
  };
  db.announcements.unshift(announcement);

  const metadata = { announcementId: announcement.id, sentBy: req.admin.email, audience: targetAudience };
  for (const userId of targetIds) {
    writeUserNotification(db, userId, announcementType, title.trim(), body.trim(), metadata);
  }
  saveAppState(db);

  logAdminAction(req, 'ANNOUNCEMENT_BROADCAST', {
    announcementId: announcement.id,
    type: announcementType,
    recipientCount: targetIds.length,
  });

  res.json({ success: true, announcement, recipientCount: targetIds.length });
});

module.exports = router;
