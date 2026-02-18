const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const DB_FILE = path.join(__dirname, 'db.json');
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const PORT = process.env.PORT || 4000;

// Idempotency store: { key: { response, timestamp } }
// Clean up keys older than 24 hours
const idempotencyStore = new Map();
const IDEMPOTENCY_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

function cleanExpiredIdempotencyKeys() {
  const now = Date.now();
  for (const [key, value] of idempotencyStore.entries()) {
    if (now - value.timestamp > IDEMPOTENCY_EXPIRY) {
      idempotencyStore.delete(key);
    }
  }
}

// Clean expired keys every hour
setInterval(cleanExpiredIdempotencyKeys, 60 * 60 * 1000);

// Currency decimals map (minor units)
const currencyDecimals = {
  USD: 2,
  EUR: 2,
  CNY: 2,
  CAD: 2,
  BRL: 2,
  GBP: 2,
  JPY: 0,
  NGN: 2,
  XAF: 2,
  GHS: 2,
  ZAR: 2,
  CNY: 2,
  XOF: 0,
  KES: 2,
  TZS: 2,
  UGX: 0,
  RWF: 0,
  ETB: 2,
  BWP: 2,
  ZWL: 2,
  MZN: 2,
  NAD: 2,
  LSL: 2,
  EGP: 2,
  TND: 3,
  MAD: 2,
  LYD: 3,
  DZD: 2,
  ERN: 2,
  AOA: 2,
  SOS: 2,
  SDG: 2,
  GMD: 2,
  MUR: 2,
  SCR: 2,
};

function decimalsFor(currency) {
  return currencyDecimals[currency] || 2;
}

function minorToMajor(amountMinor, currency) {
  const d = decimalsFor(currency);
  return amountMinor / Math.pow(10, d);
}

function majorToMinor(amountMajor, currency) {
  const d = decimalsFor(currency);
  return Math.round(amountMajor * Math.pow(10, d));
}

function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    const initial = {
      users: [],
      wallets: [],
      transactions: [],
      paymentRequests: [],
      virtualCards: [],
      budgets: [],
      rates: {
        base: 'USD',
        values: { 
          USD: 1, EUR: 0.93, CNY: 7, CAD: 1.35, BRL: 5.2, GBP: 0.79, JPY: 145,
          NGN: 1540, GHS: 12, XAF: 600, XOF: 600, ZAR: 19,
          KES: 130, TZS: 2650, UGX: 3800, RWF: 1300, ETB: 52,
          BWP: 14, ZWL: 360, MZN: 65, NAD: 19, LSL: 19,
          EGP: 50, TND: 3.1, MAD: 10, LYD: 4.8, DZD: 135,
          ERN: 15, AOA: 835, SOS: 570, SDG: 550, GMD: 65, MUR: 45, SCR: 13
        },
        updatedAt: Date.now()
      }
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoints (Railway uses /healthz by default)
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// Helpers
function findUserByEmail(db, email) {
  return db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Auth
app.post('/auth/register', (req, res) => {
  const db = loadDB();
  const { email, password, region } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (findUserByEmail(db, email)) return res.status(400).json({ error: 'User exists' });

  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(password, 8);
  
  // Auto-detect preferred currency from region
  const regionToCurrency = { 
    GQ: 'XAF', NG: 'NGN', GH: 'GHS', ZA: 'ZAR', KE: 'KES', TZ: 'TZS', 
    UG: 'UGX', RW: 'RWF', ET: 'ETB', EG: 'EGP', TN: 'TND', MA: 'MAD',
    LY: 'LYD', DZ: 'DZD', AO: 'AOA', ER: 'ERN', SO: 'SOS', SD: 'SDG',
    GM: 'GMD', MU: 'MUR', SC: 'SCR', BW: 'BWP', ZW: 'ZWL', MZ: 'MZN',
    NA: 'NAD', LS: 'LSL'
  };
  const preferredCurrency = regionToCurrency[region] || 'XAF';
  
  const user = { id, email, region: region || 'GQ', preferredCurrency, autoConvertIncoming: true, createdAt: Date.now() };
  db.users.push({ ...user, passwordHash });

  // create wallet
  const wallet = { id: uuidv4(), userId: id, balances: [{ currency: 'USD', amount: 0 }], createdAt: Date.now(), maxLimitUSD: 250000 };
  db.wallets.push(wallet);

  saveDB(db);

  const token = jwt.sign({ userId: id, email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: user, walletId: wallet.id });
});

app.post('/auth/login', (req, res) => {
  const db = loadDB();
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const u = findUserByEmail(db, email);
  if (!u) return res.status(401).json({ error: 'Invalid credentials' });
  if (!bcrypt.compareSync(password, u.passwordHash)) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ userId: u.id, email: u.email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: u.id, email: u.email, region: u.region, preferredCurrency: u.preferredCurrency || 'XAF', autoConvertIncoming: u.autoConvertIncoming !== false } });
});

app.get('/auth/me', authMiddleware, (req, res) => {
  const db = loadDB();
  const user = db.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, email: user.email, preferredCurrency: user.preferredCurrency || 'XAF', autoConvertIncoming: user.autoConvertIncoming !== false });
});

app.post('/auth/update-currency', authMiddleware, (req, res) => {
  const db = loadDB();
  const { preferredCurrency } = req.body;
  if (!preferredCurrency) return res.status(400).json({ error: 'preferredCurrency required' });
  const user = db.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.preferredCurrency = preferredCurrency;
  saveDB(db);
  res.json({ success: true, preferredCurrency });
});

app.post('/auth/update-auto-convert', authMiddleware, (req, res) => {
  const db = loadDB();
  const { autoConvertIncoming } = req.body;
  if (typeof autoConvertIncoming !== 'boolean') return res.status(400).json({ error: 'autoConvertIncoming must be boolean' });
  const user = db.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.autoConvertIncoming = autoConvertIncoming;
  saveDB(db);
  res.json({ success: true, autoConvertIncoming });
});

// Wallet endpoints
app.get('/wallets/:id/balance', authMiddleware, (req, res) => {
  const db = loadDB();
  const wallet = db.wallets.find(w => w.id === req.params.id && w.userId === req.user.userId);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  res.json({ balances: wallet.balances, maxLimitUSD: wallet.maxLimitUSD });
});

// List wallets for authenticated user
app.get('/wallets', authMiddleware, (req, res) => {
  const db = loadDB();
  const wallets = db.wallets.filter(w => w.userId === req.user.userId);
  res.json({ wallets });
});

app.get('/wallets/:id/transactions', authMiddleware, (req, res) => {
  const db = loadDB();
  const wallet = db.wallets.find(w => w.id === req.params.id && w.userId === req.user.userId);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  const txs = db.transactions.filter(t => t.fromWalletId === wallet.id || t.toWalletId === wallet.id).sort((a,b)=>b.timestamp-a.timestamp);
  res.json({ transactions: txs });
});

// Send money (simple internal transfer between wallets by walletId)
app.post('/transactions', authMiddleware, (req, res) => {
  const db = loadDB();
  const { fromWalletId, toWalletId, amount, currency, memo } = req.body; // amount is expected in minor units (integer)
  if (!fromWalletId || !toWalletId || typeof amount === 'undefined' || !currency) return res.status(400).json({ error: 'missing fields' });
  
  const fromWallet = db.wallets.find(w => w.id === fromWalletId && w.userId === req.user.userId);
  if (!fromWallet) return res.status(404).json({ error: 'Source wallet not found' });
  const toWallet = db.wallets.find(w => w.id === toWalletId);
  if (!toWallet) return res.status(404).json({ error: 'Destination wallet not found' });
  
  // find balance entries (amount stored in minor units)
  const fromBalance = fromWallet.balances.find(b=>b.currency===currency) || { currency, amount: 0 };
  if (fromBalance.amount < amount) return res.status(400).json({ error: 'Insufficient funds' });
  
  const rates = db.rates.values;
  const amountMajor = minorToMajor(amount, currency);
  const toAmountInUSD = amountMajor / (rates[currency] || 1);
  
  // CHECK #1: Daily sending limit ($5,000 USD per 24 hours)
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
  const recentTxs = db.transactions.filter(t => t.fromWalletId === fromWalletId && t.timestamp > oneDayAgo && t.status === 'completed');
  const dailySentUSD = recentTxs.reduce((sum, t) => {
    const txMajor = minorToMajor(t.amount, t.currency);
    const txUSD = txMajor / (rates[t.currency] || 1);
    return sum + txUSD;
  }, 0);
  
  const newDailyTotal = dailySentUSD + toAmountInUSD;
  const DAILY_SEND_LIMIT_USD = 5000;
  if (newDailyTotal > DAILY_SEND_LIMIT_USD) {
    return res.status(400).json({ 
      error: `Daily sending limit exceeded. You have sent ${dailySentUSD.toFixed(2)} USD today. Limit is ${DAILY_SEND_LIMIT_USD} USD per 24 hours.`,
      dailySent: dailySentUSD,
      dailyLimit: DAILY_SEND_LIMIT_USD
    });
  }
  
  // CHECK #2: Max wallet capacity ($250,000 USD) for destination
  const destTotalUSD = toWallet.balances.reduce((s,b)=>{
    const bMajor = minorToMajor(b.amount, b.currency);
    return s + (bMajor / (rates[b.currency] || 1));
  },0) + toAmountInUSD;
  
  const MAX_WALLET_CAPACITY_USD = toWallet.maxLimitUSD || 250000;
  if (destTotalUSD > MAX_WALLET_CAPACITY_USD) {
    return res.status(400).json({ 
      error: `Destination wallet would exceed maximum capacity of ${MAX_WALLET_CAPACITY_USD.toLocaleString()} USD`,
      destinationTotal: destTotalUSD,
      maxCapacity: MAX_WALLET_CAPACITY_USD
    });
  }
  
  // Get receiver's preferred currency and auto-convert setting
  const toUser = db.users.find(u => u.id === toWallet.userId);
  const shouldAutoConvert = toUser?.autoConvertIncoming !== false;
  const receiverCurrency = shouldAutoConvert ? (toUser?.preferredCurrency || currency) : currency;
  
  // Deduct from sender in original currency
  fromBalance.amount -= amount;
  
  // Convert to receiver's preferred currency if different AND auto-convert is enabled
  let receivedAmount = amount;
  let receivedCurrency = currency;
  let wasConverted = false;
  
  if (shouldAutoConvert && receiverCurrency !== currency) {
    // Convert: original → USD → receiver's currency
    const amountMajor = minorToMajor(amount, currency);
    const amountUSD = amountMajor / (rates[currency] || 1);
    const amountInReceiverCurrency = amountUSD * (rates[receiverCurrency] || 1);
    receivedAmount = majorToMinor(amountInReceiverCurrency, receiverCurrency);
    receivedCurrency = receiverCurrency;
    wasConverted = true;
  }
  
  // Add to receiver in their preferred currency
  const destBalance = toWallet.balances.find(b=>b.currency===receivedCurrency);
  if (destBalance) destBalance.amount += receivedAmount; 
  else toWallet.balances.push({ currency: receivedCurrency, amount: receivedAmount });
  
  const tx = { 
    id: uuidv4(), 
    fromWalletId, 
    toWalletId, 
    amount, 
    currency, 
    receivedAmount, 
    receivedCurrency,
    wasConverted,
    memo: memo||'', 
    status: 'completed', 
    timestamp: Date.now() 
  };
  db.transactions.push(tx);
  saveDB(db);

  res.json({ transaction: tx });
});

// Rates
app.get('/rates', (req, res) => {
  const db = loadDB();
  res.json(db.rates);
});

// Basic user info
app.get('/me', authMiddleware, (req, res) => {
  const db = loadDB();
  const u = db.users.find(x=>x.id===req.user.userId);
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json({ id: u.id, email: u.email, region: u.region });
});

// ==================== PAYMENT REQUESTS ====================
// Create a payment request
app.post('/payment-requests', authMiddleware, (req, res) => {
  const db = loadDB();
  const { walletId, amount, currency, memo, idempotencyKey } = req.body;
  if (!walletId || typeof amount === 'undefined' || !currency) {
    return res.status(400).json({ error: 'walletId, amount, and currency required' });
  }
  
  // Check idempotency
  if (idempotencyKey) {
    const cached = idempotencyStore.get(idempotencyKey);
    if (cached) {
      console.log(`Returning cached response for idempotency key: ${idempotencyKey}`);
      return res.json(cached.response);
    }
  }
  
  const wallet = db.wallets.find(w => w.id === walletId && w.userId === req.user.userId);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  
  const request = {
    id: uuidv4(),
    requesterId: req.user.userId,
    walletId,
    amount,
    currency,
    memo: memo || '',
    status: 'pending', // pending, paid, cancelled
    createdAt: Date.now(),
    paidAt: null,
    paidBy: null,
    transactionId: null
  };
  
  db.paymentRequests.push(request);
  saveDB(db);
  
  const response = { request };
  
  // Store idempotency key
  if (idempotencyKey) {
    idempotencyStore.set(idempotencyKey, { response, timestamp: Date.now() });
  }
  
  res.json(response);
});

// List payment requests (created by user)
app.get('/payment-requests', authMiddleware, (req, res) => {
  const db = loadDB();
  const requests = db.paymentRequests
    .filter(r => r.requesterId === req.user.userId)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ requests });
});

// Get a single payment request by ID (public - shareable link)
app.get('/payment-requests/:id', (req, res) => {
  const db = loadDB();
  const request = db.paymentRequests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  
  const requester = db.users.find(u => u.id === request.requesterId);
  res.json({ 
    request,
    requesterEmail: requester?.email || 'Unknown'
  });
});

// Pay a payment request
app.post('/payment-requests/:id/pay', authMiddleware, (req, res) => {
  const db = loadDB();
  const { fromWalletId } = req.body;
  if (!fromWalletId) return res.status(400).json({ error: 'fromWalletId required' });
  
  const request = db.paymentRequests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request already processed' });
  
  const fromWallet = db.wallets.find(w => w.id === fromWalletId && w.userId === req.user.userId);
  if (!fromWallet) return res.status(404).json({ error: 'Source wallet not found' });
  
  const toWallet = db.wallets.find(w => w.id === request.walletId);
  if (!toWallet) return res.status(404).json({ error: 'Destination wallet not found' });
  
  // Check balance
  const fromBalance = fromWallet.balances.find(b => b.currency === request.currency) || { currency: request.currency, amount: 0 };
  if (fromBalance.amount < request.amount) return res.status(400).json({ error: 'Insufficient funds' });
  
  // Deduct from payer
  fromBalance.amount -= request.amount;
  
  // Add to requester
  const destBalance = toWallet.balances.find(b => b.currency === request.currency);
  if (destBalance) destBalance.amount += request.amount;
  else toWallet.balances.push({ currency: request.currency, amount: request.amount });
  
  // Create transaction
  const tx = {
    id: uuidv4(),
    fromWalletId,
    toWalletId: request.walletId,
    amount: request.amount,
    currency: request.currency,
    receivedAmount: request.amount,
    receivedCurrency: request.currency,
    wasConverted: false,
    memo: `Payment for request: ${request.memo}`,
    status: 'completed',
    timestamp: Date.now()
  };
  db.transactions.push(tx);
  
  // Update request
  request.status = 'paid';
  request.paidAt = Date.now();
  request.paidBy = req.user.userId;
  request.transactionId = tx.id;
  
  saveDB(db);
  res.json({ request, transaction: tx });
});

// Cancel a payment request
app.post('/payment-requests/:id/cancel', authMiddleware, (req, res) => {
  const db = loadDB();
  const request = db.paymentRequests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.requesterId !== req.user.userId) return res.status(403).json({ error: 'Unauthorized' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request already processed' });
  
  request.status = 'cancelled';
  saveDB(db);
  res.json({ request });
});

// ==================== VIRTUAL CARDS ====================
// Create virtual card
app.post('/virtual-cards', authMiddleware, (req, res) => {
  const db = loadDB();
  const { walletId, currency, label, idempotencyKey } = req.body;
  if (!walletId || !currency) return res.status(400).json({ error: 'walletId and currency required' });
  
  // Check idempotency
  if (idempotencyKey) {
    const cached = idempotencyStore.get(idempotencyKey);
    if (cached) {
      console.log(`Returning cached response for idempotency key: ${idempotencyKey}`);
      return res.json(cached.response);
    }
  }
  
  const wallet = db.wallets.find(w => w.id === walletId && w.userId === req.user.userId);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  
  // Check card limit (max 5 cards per user)
  const userCards = (db.virtualCards || []).filter(c => c.userId === req.user.userId && c.status !== 'deleted');
  if (userCards.length >= 5) return res.status(400).json({ error: 'Maximum 5 cards allowed' });
  
  // Generate card details
  const cardNumber = '4' + Math.floor(Math.random() * 1e15).toString().padStart(15, '0');
  const cvv = Math.floor(Math.random() * 900 + 100).toString();
  const now = new Date();
  const expiryMonth = (now.getMonth() + 1).toString().padStart(2, '0');
  const expiryYear = (now.getFullYear() + 3).toString().slice(-2);
  
  const card = {
    id: uuidv4(),
    userId: req.user.userId,
    walletId,
    cardNumber,
    cvv,
    expiryMonth,
    expiryYear,
    currency,
    label: label || 'Virtual Card',
    status: 'active', // active, frozen, deleted
    createdAt: Date.now(),
    spentToday: 0,
    dailyLimit: majorToMinor(1000, currency) // $1000 daily limit
  };
  
  if (!db.virtualCards) db.virtualCards = [];
  db.virtualCards.push(card);
  saveDB(db);
  
  const response = { card };
  
  // Store idempotency key
  if (idempotencyKey) {
    idempotencyStore.set(idempotencyKey, { response, timestamp: Date.now() });
  }
  
  res.json(response);
});

// List virtual cards
app.get('/virtual-cards', authMiddleware, (req, res) => {
  const db = loadDB();
  const cards = (db.virtualCards || [])
    .filter(c => c.userId === req.user.userId && c.status !== 'deleted')
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ cards });
});

// Get single card
app.get('/virtual-cards/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  const card = (db.virtualCards || []).find(c => c.id === req.params.id && c.userId === req.user.userId);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  res.json({ card });
});

// Freeze/unfreeze card
app.post('/virtual-cards/:id/toggle-freeze', authMiddleware, (req, res) => {
  const db = loadDB();
  const { idempotencyKey } = req.body;
  
  // Check idempotency
  if (idempotencyKey) {
    const cached = idempotencyStore.get(idempotencyKey);
    if (cached) {
      console.log(`Returning cached response for idempotency key: ${idempotencyKey}`);
      return res.json(cached.response);
    }
  }
  
  const card = (db.virtualCards || []).find(c => c.id === req.params.id && c.userId === req.user.userId);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  if (card.status === 'deleted') return res.status(400).json({ error: 'Card is deleted' });
  
  card.status = card.status === 'active' ? 'frozen' : 'active';
  saveDB(db);
  
  const response = { card };
  
  // Store idempotency key
  if (idempotencyKey) {
    idempotencyStore.set(idempotencyKey, { response, timestamp: Date.now() });
  }
  
  res.json(response);
});

// Delete card
app.delete('/virtual-cards/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  const card = (db.virtualCards || []).find(c => c.id === req.params.id && c.userId === req.user.userId);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  
  card.status = 'deleted';
  saveDB(db);
  res.json({ success: true });
});

// ==================== BUDGETS ====================
// Create or update budget
app.post('/budgets', authMiddleware, (req, res) => {
  const db = loadDB();
  const { walletId, currency, monthlyLimit, categoryLimits, idempotencyKey } = req.body;
  if (!walletId || !currency || typeof monthlyLimit === 'undefined') {
    return res.status(400).json({ error: 'walletId, currency, and monthlyLimit required' });
  }
  
  // Check idempotency
  if (idempotencyKey) {
    const cached = idempotencyStore.get(idempotencyKey);
    if (cached) {
      console.log(`Returning cached response for idempotency key: ${idempotencyKey}`);
      return res.json(cached.response);
    }
  }
  
  const wallet = db.wallets.find(w => w.id === walletId && w.userId === req.user.userId);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  
  if (!db.budgets) db.budgets = [];
  
  // Check if budget already exists for this wallet+currency
  let budget = db.budgets.find(b => b.walletId === walletId && b.currency === currency && b.userId === req.user.userId);
  
  if (budget) {
    // Update existing
    budget.monthlyLimit = monthlyLimit;
    budget.categoryLimits = categoryLimits || {};
    budget.updatedAt = Date.now();
  } else {
    // Create new
    budget = {
      id: uuidv4(),
      userId: req.user.userId,
      walletId,
      currency,
      monthlyLimit,
      categoryLimits: categoryLimits || {}, // { 'Food': 500, 'Transport': 200, etc }
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    db.budgets.push(budget);
  }
  
  saveDB(db);
  
  const response = { budget };
  
  // Store idempotency key
  if (idempotencyKey) {
    idempotencyStore.set(idempotencyKey, { response, timestamp: Date.now() });
  }
  
  res.json(response);
});

// Get budgets
app.get('/budgets', authMiddleware, (req, res) => {
  const db = loadDB();
  const budgets = (db.budgets || []).filter(b => b.userId === req.user.userId);
  res.json({ budgets });
});

// Get budget analytics
app.get('/budgets/:id/analytics', authMiddleware, (req, res) => {
  const db = loadDB();
  const budget = (db.budgets || []).find(b => b.id === req.params.id && b.userId === req.user.userId);
  if (!budget) return res.status(404).json({ error: 'Budget not found' });
  
  // Calculate spending for current month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).getTime();
  
  const monthlyTxs = db.transactions.filter(t => 
    t.fromWalletId === budget.walletId &&
    t.currency === budget.currency &&
    t.timestamp >= monthStart &&
    t.timestamp <= monthEnd &&
    t.status === 'completed'
  );
  
  const totalSpent = monthlyTxs.reduce((sum, t) => sum + t.amount, 0);
  const percentUsed = (minorToMajor(totalSpent, budget.currency) / minorToMajor(budget.monthlyLimit, budget.currency)) * 100;
  
  res.json({
    budget,
    analytics: {
      monthlyLimit: budget.monthlyLimit,
      totalSpent,
      remaining: Math.max(0, budget.monthlyLimit - totalSpent),
      percentUsed: Math.min(100, percentUsed),
      transactionCount: monthlyTxs.length,
      month: `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`
    }
  });
});

// Delete budget
app.delete('/budgets/:id', authMiddleware, (req, res) => {
  const db = loadDB();
  const idx = (db.budgets || []).findIndex(b => b.id === req.params.id && b.userId === req.user.userId);
  if (idx === -1) return res.status(404).json({ error: 'Budget not found' });
  
  db.budgets.splice(idx, 1);
  saveDB(db);
  res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`EGWallet backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`JWT_SECRET configured: ${JWT_SECRET ? 'YES' : 'NO'}`);
  console.log(`Health check endpoints: /health and /healthz`);
});

