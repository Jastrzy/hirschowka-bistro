// Hirschówka Bistro — Przelewy24 Serverless Function
// Vercel: api/p24.js
// Obsługuje: rejestrację transakcji i weryfikację płatności

const crypto = require('crypto');

const SANDBOX   = process.env.P24_SANDBOX !== 'false'; // domyślnie sandbox
const BASE_URL  = SANDBOX
  ? 'https://sandbox.przelewy24.pl'
  : 'https://secure.przelewy24.pl';
const MERCHANT  = process.env.P24_MERCHANT_ID;
const CRC       = process.env.P24_CRC;
const API_KEY   = process.env.P24_API_KEY;
const POS_ID    = process.env.P24_POS_ID || MERCHANT; // zwykle taki sam jak MERCHANT

// Podpis SHA384 dla rejestracji transakcji
function signRegister(sessionId, amount, currency) {
  const data = JSON.stringify({
    sessionId,
    merchantId: parseInt(MERCHANT, 16) || MERCHANT,
    amount,
    currency
  });
  return crypto.createHash('sha384').update(data + CRC).digest('hex');
}

// Podpis SHA384 dla weryfikacji
function signVerify(sessionId, orderId, amount, currency) {
  const data = JSON.stringify({
    sessionId,
    orderId,
    amount,
    currency
  });
  return crypto.createHash('sha384').update(data + CRC).digest('hex');
}

// Nagłówki autoryzacji Basic Auth
function authHeader() {
  const token = Buffer.from(`${MERCHANT}:${API_KEY}`).toString('base64');
  return `Basic ${token}`;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.query;

  // ── REJESTRACJA TRANSAKCJI ──────────────────────────────
  if (action === 'register') {
    const { orderId, amount, email, phone, name, description, returnUrl, notifyUrl } = req.body;

    if (!orderId || !amount || !email) {
      return res.status(400).json({ error: 'Brak wymaganych danych: orderId, amount, email' });
    }

    const amountGrosze = Math.round(parseFloat(amount) * 100);
    const sessionId    = `HB-${orderId}-${Date.now()}`;
    const sign         = signRegister(sessionId, amountGrosze, 'PLN');

    const body = {
      merchantId:  parseInt(MERCHANT, 16) || parseInt(MERCHANT),
      posId:       parseInt(POS_ID, 16)   || parseInt(POS_ID),
      sessionId,
      amount:      amountGrosze,
      currency:    'PLN',
      description: description || `Zamówienie ${orderId} — Hirschówka Bistro`,
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

      if (data.data && data.data.token) {
        return res.status(200).json({
          token:      data.data.token,
          sessionId,
          payUrl:     `${BASE_URL}/trnRequest/${data.data.token}`,
          sandbox:    SANDBOX,
        });
      } else {
        console.error('[P24] register error:', data);
        return res.status(500).json({ error: data.error || 'Błąd rejestracji transakcji', raw: data });
      }
    } catch (e) {
      console.error('[P24] register fetch error:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── WERYFIKACJA PŁATNOŚCI (webhook od P24) ──────────────
  if (action === 'notify') {
    const { merchantId, posId, sessionId, amount, originAmount, currency, orderId, methodId, statement, sign } = req.body;

    // Sprawdź podpis
    const expectedSign = signVerify(sessionId, orderId, amount, currency);
    if (sign !== expectedSign) {
      console.error('[P24] notify — nieprawidłowy podpis!');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // Potwierdź transakcję w P24
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

      if (data.data && data.data.status === 'success') {
        // Płatność zweryfikowana — wyciągnij orderId z sessionId (HB-#12345-timestamp)
        const parts    = sessionId.split('-');
        const orderNum = parts.slice(1, -1).join('-'); // np. #12345
        console.log(`[P24] ✅ Płatność potwierdzona: ${orderNum}, kwota: ${amount / 100} PLN`);
        // Tu możesz dodać zapis statusu do Firebase jeśli potrzeba
        return res.status(200).json({ status: 'ok' });
      } else {
        console.error('[P24] verify failed:', data);
        return res.status(500).json({ error: 'Weryfikacja nieudana', raw: data });
      }
    } catch (e) {
      console.error('[P24] verify fetch error:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Nieznana akcja. Użyj: register lub notify' });
}
