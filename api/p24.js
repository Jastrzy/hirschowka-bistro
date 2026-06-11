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

function signVerify(sessionId, orderId, amount, originAmount, currency, methodId, statement) {
  const obj = { sessionId, orderId, amount, originAmount, currency, methodId, statement, crc: CRC };
  return crypto.createHash('sha384').update(JSON.stringify(obj)).digest('hex');
}

// Podpis dla endpointu /transaction/verify (tylko 4 pola + crc)
function signForVerify(sessionId, orderId, amount, currency) {
  const obj = { sessionId, orderId, amount, currency, crc: CRC };
  return crypto.createHash('sha384').update(JSON.stringify(obj)).digest('hex');
}

// Aktualizuj status zamówienia w Firebase
async function updateOrderStatus(orderId, status) {
  try {
    const searchUrl = `${FB_URL}/orders.json?orderBy="id"&equalTo="${orderId}"${FB_SECRET?'&auth='+FB_SECRET:''}`;
    console.log('[P24] Firebase search URL:', searchUrl.replace(FB_SECRET||'x', '***'));
    const searchResp = await fetch(searchUrl);
    console.log('[P24] Firebase search status:', searchResp.status);
    const orders = await searchResp.json();
    console.log('[P24] Firebase orders found:', JSON.stringify(orders));
    if (!orders || typeof orders !== 'object' || Object.keys(orders).length === 0) {
      console.warn('[P24] Nie znaleziono zamowienia:', orderId);
      return;
    }

    const updates = Object.keys(orders).map(async (key) => {
      const updateUrl = `${FB_URL}/orders/${key}.json${FB_SECRET?'?auth='+FB_SECRET:''}`;
      const updateResp = await fetch(updateUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      console.log('[P24] Firebase update', key, '→', status, ':', updateResp.status);
    });
    await Promise.all(updates);
    console.log('[P24] Status zamowienia zaktualizowany:', orderId, '→', status);
  } catch(e) {
    console.error('[P24] Blad aktualizacji Firebase:', e.message);
  }
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

  if (action === 'notify') {
    const body = req.body || {};
    const { merchantId, posId, sessionId, amount, originAmount, currency, orderId, methodId, statement, sign } = body;

    console.log('[P24] notify received:', JSON.stringify({ sessionId, orderId, amount, currency, sign: sign?.slice(0,16)+'...' }));

    // Do weryfikacji P24 wymaga naszego podpisu (nie oryginalnego od P24)
    const verifySign = signForVerify(sessionId, orderId, amount, currency);
    const verifyBody = {
      merchantId: MERCHANT_ID,
      posId:      POS_ID,
      sessionId,
      amount,
      currency,
      orderId,
      sign: verifySign,
    };

    try {
      const resp = await fetch(`${BASE_URL}/api/v1/transaction/verify`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': authHeader() },
        body: JSON.stringify(verifyBody),
      });
      const data = await resp.json();
      console.log('[P24] verify response:', JSON.stringify(data));

      if (data.data && data.data.status === 'success') {
        // Wyciągnij numer zamówienia z sessionId (format: HB-#79077-timestamp)
        const parts = sessionId.split('-');
        const orderNum = parts.slice(1, -1).join('-');
        await updateOrderStatus(orderNum, 'paid');
        console.log('[P24] ✅ Platnosc potwierdzona:', orderNum);
        return res.status(200).json({ status: 'ok' });
      } else {
        console.warn('[P24] verify nie udana:', data);
        return res.status(200).json({ status: 'received' }); // 200 żeby P24 nie ponawiał
      }
    } catch(e) {
      console.error('[P24] verify error:', e.message);
      return res.status(200).json({ status: 'error', message: e.message });
    }
  }

  return res.status(400).json({ error: 'Nieznana akcja' });
};
