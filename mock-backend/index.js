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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`EGWallet backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`JWT_SECRET configured: ${JWT_SECRET ? 'YES' : 'NO'}`);
  console.log(`Health check endpoints: /health and /healthz`);
});

