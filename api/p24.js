// Hirschówka Bistro — Przelewy24 Serverless Function
// Vercel: api/p24.js

const crypto = require('crypto');

const SANDBOX     = process.env.P24_SANDBOX !== 'false';
const BASE_URL    = SANDBOX
  ? 'https://sandbox.przelewy24.pl'
  : 'https://secure.przelewy24.pl';

const MERCHANT_ID = parseInt(process.env.P24_MERCHANT_ID, 10);
const POS_ID      = parseInt(process.env.P24_POS_ID || process.env.P24_MERCHANT_ID, 10);
const CRC         = process.env.P24_CRC;
const API_KEY     = process.env.P24_API_KEY;
const FB_URL      = process.env.FIREBASE_DB_URL || 'https://hirschowka-bistro-default-rtdb.europe-west1.firebasedatabase.app';
const FB_SECRET   = process.env.FIREBASE_SECRET;

// Logowanie do Firebase — widoczne w panelu admina i Firebase Console
async function fbLog(level, msg, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    data: data || null,
  };
  console.log(`[P24][${level}]`, msg, data ? JSON.stringify(data) : '');
  try {
    await fetch(`${FB_URL}/p24-logs.json${FB_SECRET?'?auth='+FB_SECRET:''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
  } catch(e) { /* nie blokuj głównej logiki */ }
}

function authHeader() {
  return 'Basic ' + Buffer.from(`${POS_ID}:${API_KEY}`).toString('base64');
}

function signRegister(sessionId, amount, currency) {
  const obj = { sessionId, merchantId: MERCHANT_ID, amount, currency, crc: CRC };
  return crypto.createHash('sha384').update(JSON.stringify(obj)).digest('hex');
}

// Podpis dla endpointu /transaction/verify
// Dokumentacja P24: { sessionId, orderId, amount, currency, crc } — BEZ merchantId
function signForVerify(sessionId, orderId, amount, currency) {
  const obj = { sessionId, orderId, amount, currency, crc: CRC };
  return crypto.createHash('sha384').update(JSON.stringify(obj)).digest('hex');
}

// Przyznaj pieczątkę klientowi po opłaconym zamówieniu
async function grantStampForOrder(order) {
  try {
    if (!order || !order.phone) {
      await fbLog('WARN', 'grantStamp: brak telefonu w zamowieniu', { orderId: order && order.id });
      return false;
    }
    const total = parseFloat(order.total || 0);
    if (total < 19) {
      await fbLog('INFO', 'grantStamp: kwota za niska', { total, orderId: order.id });
      return false;
    }

    const phone = String(order.phone).replace(/\s/g, '');

    // Pobierz bazę klientów
    const custResp = await fetch(`${FB_URL}/customers.json${FB_SECRET ? '?auth=' + FB_SECRET : ''}`);
    const custVal = await custResp.json();

    let customers = {};
    let matchKey = null;
    let matchCust = null;

    if (custVal && typeof custVal === 'object') {
      customers = custVal;
      // Szukaj po telefonie
      for (const [key, c] of Object.entries(customers)) {
        if (c && String(c.phone || '').replace(/\s/g, '') === phone) {
          matchKey = key;
          matchCust = { ...c };
          break;
        }
      }
    }

    if (matchKey && matchCust) {
      // Klient istnieje — dodaj pieczątkę
      const prev = matchCust.stamps || 0;
      matchCust.stamps = prev >= 9 ? 1 : prev + 1;
      matchCust.totalStamps = (matchCust.totalStamps || 0) + 1;
      matchCust.visits = (matchCust.visits || 0) + 1;
      matchCust.last = new Date().toLocaleDateString('pl-PL');
      matchCust.spent = (matchCust.spent || 0) + total;

      const updateUrl = `${FB_URL}/customers/${matchKey}.json${FB_SECRET ? '?auth=' + FB_SECRET : ''}`;
      await fetch(updateUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stamps: matchCust.stamps,
          totalStamps: matchCust.totalStamps,
          visits: matchCust.visits,
          last: matchCust.last,
          spent: matchCust.spent,
        }),
      });
      await fbLog('INFO', '⭐ Pieczatka przyznana (istniejacy klient)', { phone, stamps: matchCust.stamps, orderId: order.id });
    } else {
      // Nowy klient — utwórz wpis i daj pieczątkę
      const newCust = {
        name: order.customer || ('Klient ' + phone),
        phone: order.phone,
        email: order.email || '',
        sms: true,
        emailMkt: false,
        stamps: 1,
        totalStamps: 1,
        visits: 1,
        last: new Date().toLocaleDateString('pl-PL'),
        spent: total,
        registeredAt: new Date().toISOString().slice(0, 10),
      };
      await fetch(`${FB_URL}/customers.json${FB_SECRET ? '?auth=' + FB_SECRET : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newCust),
      });
      await fbLog('INFO', '⭐ Nowy klient + pieczatka', { phone, orderId: order.id });
    }
    return true;
  } catch (e) {
    await fbLog('ERROR', 'grantStamp exception', { message: e.message });
    return false;
  }
}

// Aktualizuj status zamówienia w Firebase — pobierz wszystkie i filtruj w JS
async function updateOrderStatus(orderId, status) {
  try {
    const fetchUrl = `${FB_URL}/orders.json${FB_SECRET?'?auth='+FB_SECRET:''}`;
    const resp = await fetch(fetchUrl);
    const orders = await resp.json();

    if (!orders || typeof orders !== 'object') {
      await fbLog('WARN', 'Brak zamowien w Firebase', { fetchStatus: resp.status });
      return;
    }

    const matchingKeys = Object.keys(orders).filter(key => {
      const order = orders[key];
      return order && order.id === orderId;
    });

    await fbLog('INFO', 'updateOrderStatus szukam', { orderId, znaleziono: matchingKeys.length, klucze: matchingKeys });

    if (matchingKeys.length === 0) {
      await fbLog('WARN', 'Nie znaleziono zamowienia', { orderId, dostepneId: Object.values(orders).map(o=>o&&o.id).slice(0,10) });
      return;
    }

    const updates = matchingKeys.map(async (key) => {
      const updateUrl = `${FB_URL}/orders/${key}.json${FB_SECRET?'?auth='+FB_SECRET:''}`;
      const updateResp = await fetch(updateUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      await fbLog('INFO', 'Firebase update', { key, status, updateStatus: updateResp.status });
    });
    await Promise.all(updates);
  } catch(e) {
    await fbLog('ERROR', 'Blad aktualizacji Firebase', { message: e.message });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // ── TEST ──────────────────────────────────────────────────
  if (action === 'test') {
    const testSign = signRegister('test-session', 100, 'PLN');
    return res.status(200).json({
      sandbox: SANDBOX, baseUrl: BASE_URL,
      merchantId: MERCHANT_ID, posId: POS_ID,
      crcLen: (CRC||'').length, apiKeyLen: (API_KEY||'').length,
      testSign,
    });
  }

  if (req.method !== 'POST' && action !== 'notify') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── REJESTRACJA ────────────────────────────────────────────
  if (action === 'register') {
    const { orderId, amount, email, phone, name, description, returnUrl, notifyUrl } = req.body;
    if (!orderId || !amount || !email) {
      return res.status(400).json({ error: 'Brak: orderId, amount lub email' });
    }

    const amountGrosze = Math.round(parseFloat(amount) * 100);
    const sessionId    = `HB-${orderId}-${Date.now()}`;
    const sign         = signRegister(sessionId, amountGrosze, 'PLN');

    const body = {
      merchantId: MERCHANT_ID, posId: POS_ID,
      sessionId, amount: amountGrosze, currency: 'PLN',
      description: description || `Zamowienie ${orderId} - Hirschowka Bistro`,
      email, phone: (phone||'').replace(/\D/g,''),
      country: 'PL', language: 'pl',
      urlReturn: returnUrl || 'https://www.hirschowkabistro.pl/?order=done',
      urlStatus: notifyUrl || 'https://www.hirschowkabistro.pl/api/p24?action=notify',
      sign, encoding: 'UTF-8', client: name||'',
    };

    console.log('[P24] register →', { merchantId: MERCHANT_ID, posId: POS_ID, sessionId, amountGrosze });

    try {
      const resp = await fetch(`${BASE_URL}/api/v1/transaction/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': authHeader() },
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      console.log('[P24] register', resp.status, text);
      let data; try { data = JSON.parse(text); } catch(e) { data = { raw: text }; }

      if (data.data && data.data.token) {
        return res.status(200).json({
          token: data.data.token, sessionId,
          payUrl: `${BASE_URL}/trnRequest/${data.data.token}`,
          sandbox: SANDBOX,
        });
      }
      return res.status(500).json({ error: data.error||'Blad rejestracji', code: resp.status, raw: data });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── WERYFIKACJA WEBHOOK (POST od P24) ─────────────────────
  if (action === 'notify') {
    const body = req.body || {};
    const { merchantId, posId, sessionId, amount, originAmount, currency, orderId, methodId, statement, sign } = body;

    await fbLog('INFO', 'notify received', { sessionId, orderId, amount, currency, sign });
    await fbLog('INFO', 'config', { merchantId: MERCHANT_ID, posId: POS_ID, crcLen: (CRC||'').length });

    const verifySign = signForVerify(sessionId, orderId, amount, currency);
    await fbLog('INFO', 'verifySign', { verifySign });

    const verifyBody = {
      merchantId: MERCHANT_ID,
      posId:      POS_ID,
      sessionId, amount, currency, orderId,
      sign: verifySign,
    };
    await fbLog('INFO', 'verifyBody', verifyBody);

    try {
      const resp = await fetch(`${BASE_URL}/api/v1/transaction/verify`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': authHeader() },
        body: JSON.stringify(verifyBody),
      });
      const text = await resp.text();
      await fbLog('INFO', 'verify response', { status: resp.status, body: text });
      let data; try { data = JSON.parse(text); } catch(e) { data = { raw: text }; }

      if (data.data && data.data.status === 'success') {
        const parts = sessionId.split('-');
        const orderNum = parts.slice(1, -1).join('-');
        await fbLog('INFO', 'orderNum', { parts, orderNum });
        await updateOrderStatus(orderNum, 'paid');

        // Przyznaj pieczątkę — pobierz dane zamówienia z Firebase
        try {
          const ordersResp = await fetch(`${FB_URL}/orders.json${FB_SECRET ? '?auth=' + FB_SECRET : ''}`);
          const ordersVal = await ordersResp.json();
          if (ordersVal && typeof ordersVal === 'object') {
            const entries = Object.entries(ordersVal);
            const paidEntry = entries.find(([, o]) => o && o.id === orderNum);
            if (paidEntry) {
              const [paidKey, paidOrder] = paidEntry;
              const granted = await grantStampForOrder(paidOrder);
              if (granted) {
                // Oznacz na zamówieniu, że pieczątka już poszła — inaczej panel doliczy
                // drugą, gdy obsługa oznaczy zamówienie jako "Zrealizowane"
                await fetch(`${FB_URL}/orders/${paidKey}.json${FB_SECRET ? '?auth=' + FB_SECRET : ''}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ stampGranted: true }),
                });
              }
            } else {
              await fbLog('WARN', 'grantStamp: nie znaleziono zamowienia', { orderNum });
            }
          }
        } catch (e) {
          await fbLog('ERROR', 'grantStamp fetch exception', { message: e.message });
        }

        await fbLog('INFO', '✅ Platnosc potwierdzona', { orderNum });
        return res.status(200).json({ status: 'ok' });
      } else {
        await fbLog('WARN', 'verify NIEUDANA', { status: resp.status, data });
        return res.status(200).json({ status: 'received' });
      }
    } catch(e) {
      await fbLog('ERROR', 'verify exception', { message: e.message });
      return res.status(200).json({ status: 'error', message: e.message });
    }
  }

  return res.status(400).json({ error: 'Nieznana akcja' });
};
