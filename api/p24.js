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
const FB_SECRET   = process.env.FIREBASE_SECRET; // opcjonalny — do zapisu bez auth

function authHeader() {
  return 'Basic ' + Buffer.from(`${POS_ID}:${API_KEY}`).toString('base64');
}

function signRegister(sessionId, amount, currency) {
  const obj = { sessionId, merchantId: MERCHANT_ID, amount, currency, crc: CRC };
  return crypto.createHash('sha384').update(JSON.stringify(obj)).digest('hex');
}

function signVerify(sessionId, orderId, amount, currency) {
  const obj = { sessionId, orderId, amount, currency, crc: CRC };
  return crypto.createHash('sha384').update(JSON.stringify(obj)).digest('hex');
}

// Aktualizuj status zamówienia w Firebase
async function updateOrderStatus(orderId, status) {
  try {
    // Szukaj zamówienia po id w Firebase
    const searchUrl = `${FB_URL}/orders.json?orderBy="id"&equalTo="${orderId}"${FB_SECRET?'&auth='+FB_SECRET:''}`;
    const searchResp = await fetch(searchUrl);
    const orders = await searchResp.json();
    if (!orders || typeof orders !== 'object') return;

    // Zaktualizuj status każdego pasującego zamówienia
    const updates = Object.keys(orders).map(async (key) => {
      const updateUrl = `${FB_URL}/orders/${key}.json${FB_SECRET?'?auth='+FB_SECRET:''}`;
      await fetch(updateUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    });
    await Promise.all(updates);
    console.log('[P24] Status zamowienia zaktualizowany:', orderId, '→', status);
  } catch(e) {
    console.error('[P24] Blad aktualizacji Firebase:', e.message);
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
      urlReturn: returnUrl || 'https://hirschowkabistro.pl/?order=success',
      urlStatus: notifyUrl || 'https://hirschowkabistro.pl/api/p24?action=notify',
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
    const { merchantId, posId, sessionId, amount, currency, orderId, sign } = body;

    // Loguj dokładnie co przyszło od P24
    console.log('[P24] notify body:', JSON.stringify(body));
    console.log('[P24] notify types:', {
      orderId: typeof orderId,
      amount: typeof amount,
      sessionId: typeof sessionId,
      currency: typeof currency,
    });

    // Próbuj różne warianty podpisu — P24 może przekazywać orderId jako int lub string
    const sign1 = signVerify(sessionId, orderId, amount, currency);
    const sign2 = signVerify(sessionId, parseInt(orderId, 10), amount, currency);
    const sign3 = signVerify(sessionId, String(orderId), amount, currency);
    const sign4 = signVerify(sessionId, orderId, parseInt(amount, 10), currency);
    const sign5 = signVerify(sessionId, parseInt(orderId, 10), parseInt(amount, 10), currency);

    console.log('[P24] sign variants:', { received: sign, sign1, sign2, sign3, sign4, sign5 });

    const validSign = [sign1, sign2, sign3, sign4, sign5].find(s => s === sign);
    if (!validSign) {
      console.error('[P24] notify — zly podpis! Żaden wariant nie pasuje.');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    console.log('[P24] notify — podpis OK ✓');

    // Potwierdź transakcję w P24
    const verifyBody = {
      merchantId: parseInt(merchantId, 10), posId: parseInt(posId, 10),
      sessionId, amount, currency, orderId, sign: validSign,
    };

    try {
      const resp = await fetch(`${BASE_URL}/api/v1/transaction/verify`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': authHeader() },
        body: JSON.stringify(verifyBody),
      });
      const data = await resp.json();
      console.log('[P24] verify:', JSON.stringify(data));

      if (data.data && data.data.status === 'success') {
        const parts = sessionId.split('-');
        const orderNum = parts.slice(1, -1).join('-'); // np. #79077
        await updateOrderStatus(orderNum, 'paid');
        console.log('[P24] Platnosc potwierdzona:', orderNum);
        return res.status(200).json({ status: 'ok' });
      }
      return res.status(500).json({ error: 'Weryfikacja nieudana', raw: data });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Nieznana akcja' });
};
