// Hirschówka Bistro — Przelewy24 Serverless Function
// Vercel: api/p24.js

const crypto = require('crypto');

const SANDBOX  = process.env.P24_SANDBOX !== 'false';
const BASE_URL = SANDBOX
  ? 'https://sandbox.przelewy24.pl'
  : 'https://secure.przelewy24.pl';

const MERCHANT_ID = parseInt(process.env.P24_MERCHANT_ID, 10);
const POS_ID      = parseInt(process.env.P24_POS_ID || process.env.P24_MERCHANT_ID, 10);
const CRC         = process.env.P24_CRC;
const API_KEY     = process.env.P24_API_KEY; // klucz do raportów

// Basic Auth: posId:reportsKey
function authHeader() {
  return 'Basic ' + Buffer.from(`${POS_ID}:${API_KEY}`).toString('base64');
}

// Podpis SHA384 rejestracji
function signRegister(sessionId, amount, currency) {
  const payload = JSON.stringify({ sessionId, merchantId: MERCHANT_ID, amount, currency });
  return crypto.createHash('sha384').update(payload + CRC).digest('hex');
}

// Podpis SHA384 weryfikacji
function signVerify(sessionId, orderId, amount, currency) {
  const payload = JSON.stringify({ sessionId, orderId, amount, currency });
  return crypto.createHash('sha384').update(payload + CRC).digest('hex');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.query;

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
      merchantId:  MERCHANT_ID,
      posId:       POS_ID,
      sessionId,
      amount:      amountGrosze,
      currency:    'PLN',
      description: description || `Zamowienie ${orderId} - Hirschowka Bistro`,
      email,
      phone:       (phone || '').replace(/\D/g, ''),
      country:     'PL',
      language:    'pl',
      urlReturn:   returnUrl || 'https://hirschowkabistro.pl/?order=success',
      urlStatus:   notifyUrl || 'https://hirschowkabistro.pl/api/p24?action=notify',
      sign,
      encoding:    'UTF-8',
      client:      name || '',
    };

    console.log('[P24] register →', BASE_URL, { merchantId: MERCHANT_ID, posId: POS_ID, sessionId, amountGrosze });

    try {
      const resp = await fetch(`${BASE_URL}/api/v1/transaction/register`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': authHeader(),
        },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      console.log('[P24] register response:', JSON.stringify(data));

      if (data.data && data.data.token) {
        return res.status(200).json({
          token:   data.data.token,
          sessionId,
          payUrl:  `${BASE_URL}/trnRequest/${data.data.token}`,
          sandbox: SANDBOX,
        });
      }
      return res.status(500).json({ error: data.error || 'Bład rejestracji', raw: data });
    } catch (e) {
      console.error('[P24] register error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── WERYFIKACJA (webhook) ──────────────────────────────────
  if (action === 'notify') {
    const { merchantId, posId, sessionId, amount, currency, orderId, sign } = req.body;
    const expectedSign = signVerify(sessionId, orderId, amount, currency);

    if (sign !== expectedSign) {
      console.error('[P24] notify — zly podpis!');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const verifyBody = {
      merchantId: parseInt(merchantId),
      posId:      parseInt(posId),
      sessionId,
      amount,
      currency,
      orderId,
      sign: expectedSign,
    };

    try {
      const resp = await fetch(`${BASE_URL}/api/v1/transaction/verify`, {
        method:  'PUT',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': authHeader(),
        },
        body: JSON.stringify(verifyBody),
      });
      const data = await resp.json();
      console.log('[P24] verify response:', JSON.stringify(data));

      if (data.data && data.data.status === 'success') {
        console.log('[P24] ✅ Platnosc potwierdzona:', sessionId);
        return res.status(200).json({ status: 'ok' });
      }
      return res.status(500).json({ error: 'Weryfikacja nieudana', raw: data });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Nieznana akcja. Uzyj: register lub notify' });
};
