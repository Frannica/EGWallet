'use strict';

const express = require('express');
const {
  registerPushToken,
  unregisterPushToken,
  setUserPushEnabled,
  isUserPushEnabled,
  isValidExpoPushToken,
} = require('./db/pushTokens');
const { getPushProviderReadiness, schedulePushForNotification } = require('./pushNotifications');
const { loadAppState, saveAppState } = require('./db/appStateStore');
const { v4: uuidv4 } = require('uuid');

function createPushRouter({ authMiddleware }) {
  const router = express.Router();

  // Authenticated register — token always bound to req.user.userId (never from body.userId)
  router.post('/register', authMiddleware, async (req, res) => {
    try {
      const { token, deviceId, platform, appVersion } = req.body || {};
      if (req.body?.userId && req.body.userId !== req.user.userId) {
        return res.status(403).json({ error: 'Cannot register a token for another user', errorCode: 'PUSH_USER_MISMATCH' });
      }
      if (!isValidExpoPushToken(token)) {
        return res.status(400).json({ error: 'Invalid Expo push token', errorCode: 'TOKEN_INVALID' });
      }
      const row = await registerPushToken({
        userId: req.user.userId,
        deviceId,
        token,
        platform,
        appVersion,
      });
      // Mirror preference onto JSON user if present
      try {
        const db = loadAppState();
        const u = (db.users || []).find((x) => x.id === req.user.userId);
        if (u) {
          u.pushEnabled = u.pushEnabled !== false;
          saveAppState(db);
        }
      } catch (_) {}
      return res.json({
        ok: true,
        deviceId: row.device_id,
        platform: row.platform,
        enabled: row.enabled,
        // Never echo the full token back in logs; short suffix only for client confirm
        tokenSuffix: String(token).slice(-12),
      });
    } catch (e) {
      const code = e.code || 'PUSH_REGISTER_FAILED';
      const status = code === 'DEVICE_ID_INVALID' || code === 'TOKEN_INVALID' ? 400 : 500;
      return res.status(status).json({ error: e.message || 'register failed', errorCode: code });
    }
  });

  router.post('/unregister', authMiddleware, async (req, res) => {
    try {
      const { token, deviceId } = req.body || {};
      const result = await unregisterPushToken({
        userId: req.user.userId,
        token,
        deviceId,
      });
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'unregister failed', errorCode: 'PUSH_UNREGISTER_FAILED' });
    }
  });

  router.get('/preferences', authMiddleware, async (req, res) => {
    try {
      const pushEnabled = await isUserPushEnabled(req.user.userId);
      return res.json({ pushEnabled });
    } catch (e) {
      return res.status(500).json({ error: 'preferences failed' });
    }
  });

  router.patch('/preferences', authMiddleware, async (req, res) => {
    try {
      if (typeof req.body?.pushEnabled !== 'boolean') {
        return res.status(400).json({ error: 'pushEnabled boolean required', errorCode: 'PUSH_PREF_INVALID' });
      }
      const result = await setUserPushEnabled(req.user.userId, req.body.pushEnabled);
      try {
        const db = loadAppState();
        const u = (db.users || []).find((x) => x.id === req.user.userId);
        if (u) {
          u.pushEnabled = !!req.body.pushEnabled;
          saveAppState(db);
        }
      } catch (_) {}
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(500).json({ error: 'preferences update failed' });
    }
  });

  // Readiness — no secrets. Auth optional so ops can probe; keep non-sensitive.
  router.get('/ready', (_req, res) => {
    res.json({ ok: true, ...getPushProviderReadiness() });
  });

  /**
   * Controlled self-test: authenticated user sends a push ONLY to their own tokens.
   * Does not move money. Rate-limited lightly by requiring explicit confirm body.
   */
  router.post('/test-self', authMiddleware, async (req, res) => {
    try {
      if (req.body?.confirm !== 'SEND_TEST_PUSH_TO_ME') {
        return res.status(400).json({
          error: 'Set confirm to SEND_TEST_PUSH_TO_ME',
          errorCode: 'PUSH_TEST_CONFIRM_REQUIRED',
        });
      }
      const notificationId = uuidv4();
      const title = 'EGWallet test push';
      const body = 'Push delivery works on this device.';
      try {
        const db = loadAppState();
        if (!db.notifications) db.notifications = [];
        db.notifications.unshift({
          id: notificationId,
          userId: req.user.userId,
          type: 'admin_message',
          title,
          body,
          read: false,
          metadata: { test: true },
          createdAt: Date.now(),
        });
        saveAppState(db);
      } catch (_) {}
      schedulePushForNotification({
        userId: req.user.userId,
        notificationId,
        type: 'admin_message',
        title,
        body,
        metadata: { test: true },
      });
      return res.json({ ok: true, notificationId, queued: true });
    } catch (e) {
      return res.status(500).json({ error: 'test push failed' });
    }
  });

  return router;
}

module.exports = { createPushRouter };
