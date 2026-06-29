'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { adminAuth, requirePermission, adminCsrf } = require('./adminAuth');
const { loadAppState, saveAppState } = require('./db/appStateStore');
const { logAdminAction } = require('./adminAudit');

const router = express.Router();

function sanitizeTicket(ticket, db) {
  const user = (db.users || []).find((u) => u.id === ticket.userId);
  return {
    id: ticket.id,
    userId: ticket.userId,
    userEmail: user?.email || null,
    subject: ticket.subject,
    description: ticket.description,
    category: ticket.category || 'general',
    priority: ticket.priority || 'normal',
    status: ticket.status || 'open',
    sla: ticket.sla || null,
    escalated: !!ticket.escalated,
    sentiment: ticket.sentiment || null,
    tags: ticket.tags || [],
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    replyCount: (ticket.replies || []).length,
    freshdeskId: ticket.freshdeskId || null,
  };
}

function findTicketOr404(req, res) {
  const db = loadAppState();
  const ticket = (db.supportTickets || []).find((t) => t.id === req.params.id);
  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found' });
    return null;
  }
  return { db, ticket };
}

router.get('/', adminAuth, requirePermission('tickets:read'), (req, res) => {
  const db = loadAppState();
  let tickets = [...(db.supportTickets || [])];

  if (req.query.status) tickets = tickets.filter((t) => t.status === req.query.status);
  if (req.query.userId) tickets = tickets.filter((t) => t.userId === req.query.userId);
  if (req.query.priority) tickets = tickets.filter((t) => t.priority === req.query.priority);

  tickets.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));

  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const totalItems = tickets.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / limit));
  const start = (page - 1) * limit;
  const data = tickets.slice(start, start + limit).map((t) => sanitizeTicket(t, db));

  logAdminAction(req, 'SUPPORT_TICKETS_LIST', { count: data.length, status: req.query.status || null });
  res.json({ tickets: data, page, totalPages, totalItems, count: data.length });
});

router.get('/:id', adminAuth, requirePermission('tickets:read'), (req, res) => {
  const found = findTicketOr404(req, res);
  if (!found) return;

  const { db, ticket } = found;
  logAdminAction(req, 'SUPPORT_TICKET_VIEW', { ticketId: ticket.id, userId: ticket.userId });
  res.json({
    ticket: {
      ...sanitizeTicket(ticket, db),
      description: ticket.description,
      replies: (ticket.replies || []).map((r) => ({
        id: r.id,
        from: r.from,
        adminEmail: r.adminEmail || null,
        message: r.message,
        createdAt: r.createdAt,
      })),
    },
  });
});

router.post('/:id/reply', adminAuth, adminCsrf, requirePermission('tickets:write'), (req, res) => {
  const message = (req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message is required' });

  const found = findTicketOr404(req, res);
  if (!found) return;

  const { db, ticket } = found;
  if (ticket.status === 'closed') {
    return res.status(400).json({ error: 'Cannot reply to a closed ticket' });
  }

  if (!ticket.replies) ticket.replies = [];
  const reply = {
    id: uuidv4(),
    from: 'admin',
    adminEmail: req.admin.email,
    message,
    createdAt: Date.now(),
  };
  ticket.replies.push(reply);
  ticket.updatedAt = Date.now();
  if (ticket.status === 'open') ticket.status = 'pending';
  saveAppState(db);

  logAdminAction(req, 'SUPPORT_TICKET_REPLY', { ticketId: ticket.id, userId: ticket.userId });
  res.json({ success: true, reply, ticket: sanitizeTicket(ticket, db) });
});

router.post('/:id/close', adminAuth, adminCsrf, requirePermission('tickets:write'), (req, res) => {
  const found = findTicketOr404(req, res);
  if (!found) return;

  const { db, ticket } = found;
  const resolution = (req.body?.resolution || '').trim() || null;
  ticket.status = 'closed';
  ticket.closedAt = Date.now();
  ticket.closedBy = req.admin.email;
  ticket.resolution = resolution;
  ticket.updatedAt = Date.now();
  saveAppState(db);

  logAdminAction(req, 'SUPPORT_TICKET_CLOSE', { ticketId: ticket.id, userId: ticket.userId, resolution });
  res.json({ success: true, ticket: sanitizeTicket(ticket, db) });
});

module.exports = router;
