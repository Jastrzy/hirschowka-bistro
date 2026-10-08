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
  const now = new Date();
  const dateKey = now.toISOString().slice(0,10); // np. '2026-07-31' — osobny folder na każdy dzień, żeby dało się łatwo znaleźć konkretną datę zamiast przeszukiwać jedną wielką, płaską listę
  const entry = {
    ts: now.toISOString(),
    level,
    msg,
    data: data || null,
  };
  console.log(`[P24][${level}]`, msg, data ? JSON.stringify(data) : '');
  try {
    await fetch(`${FB_URL}/p24-logs/${dateKey}.json${FB_SECRET?'?auth='+FB_SECRET:''}`, {
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

// Automatyczny kod nagrody + SMS przy osiągnięciu 3/6/9 pieczątek (płatności online).
// Odpowiednik createLoyaltyRewardCode() z panel.html, przepisany na Node.js —
// serwer nie może wywołać funkcji z przeglądarki, więc logika jest zduplikowana,
// ale musi dawać identyczny efekt (ten sam format kodu, kuponu i treści SMS).
async function autoGrantLoyaltyReward(phone, stamps) {
  try {
    if (![3, 6, 9].includes(stamps)) return;

    const rewardsResp = await fetch(`${FB_URL}/rewards.json${FB_SECRET ? '?auth=' + FB_SECRET : ''}`);
    const rewardsVal = await rewardsResp.json();
    const rewardsList = rewardsVal ? (Array.isArray(rewardsVal) ? rewardsVal : Object.values(rewardsVal)) : [];
    const rew = rewardsList.find(r => r && Number(r.stamp) === stamps);
    if (!rew) {
      await fbLog('WARN', 'autoGrantLoyaltyReward: brak zdefiniowanej nagrody', { stamps });
      return;
    }

    const code = 'LOY' + stamps + Math.random().toString(36).slice(2, 6).toUpperCase();
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + 30);
    const expStr = expDate.toISOString().slice(0, 10);

    // Dopisz kupon jednorazowy (ten sam format co ręczne przyznanie w panelu)
    const couponsResp = await fetch(`${FB_URL}/coupons.json${FB_SECRET ? '?auth=' + FB_SECRET : ''}`);
    const couponsVal = await couponsResp.json();
    const couponsList = couponsVal ? (Array.isArray(couponsVal) ? couponsVal : Object.values(couponsVal)) : [];
    couponsList.push({ code, disc: rew.discVal || 100, exp: expStr, limit: 1, used: 0, min: 0, loyaltyReward: true, rewardStamp: stamps, rewardName: rew.name, cats: rew.cats || '' });
    await fetch(`${FB_URL}/coupons.json${FB_SECRET ? '?auth=' + FB_SECRET : ''}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(couponsList),
    });

    // Dopisz do historii lojalności
    const histResp = await fetch(`${FB_URL}/loyalty-history.json${FB_SECRET ? '?auth=' + FB_SECRET : ''}`);
    const histVal = await histResp.json();
    const histList = histVal ? (Array.isArray(histVal) ? histVal : Object.values(histVal)) : [];
    histList.push({ phone, code, rewardName: rew.name, stampLevel: stamps, date: new Date().toLocaleDateString('pl-PL'), used: false });
    await fetch(`${FB_URL}/loyalty-history.json${FB_SECRET ? '?auth=' + FB_SECRET : ''}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(histList),
    });

    // Wyślij SMS z kodem — przez ten sam proxy /api/sms co panel, żeby uniknąć
    // powielania logowania do SMSAPI w dwóch miejscach
    const tokenResp = await fetch(`${FB_URL}/smsapi-token.json${FB_SECRET ? '?auth=' + FB_SECRET : ''}`);
    const token = await tokenResp.json();
    const senderResp = await fetch(`${FB_URL}/smsapi-sender.json${FB_SECRET ? '?auth=' + FB_SECRET : ''}`);
    const senderVal = await senderResp.json();
    const sender = senderVal || 'Hirschowka';

    if (token) {
      const cleanPhone = '48' + String(phone).replace(/\s/g, '').replace(/^\+48/, '').replace(/\D/g, '');
      const smsText = stamps === 3
        ? `Hirschowka: Gratulacje! Masz 3 pieczatki. Twoja nagroda: 50% na kawe lub deser. Kod: ${code}. Wazny 30 dni.`
        : stamps === 6
        ? `Hirschowka: Gratulacje! Masz 6 pieczątek. Twoja nagroda: darmowa kawa lub deser. Kod: ${code}. Wazny 30 dni.`
        : `Hirschowka: Gratulacje! Masz 9 pieczątek. Twoja nagroda: 50% na bajgiel lub danie dnia. Kod: ${code}. Wazny 30 dni.`;
      await fetch('https://www.hirschowkabistro.pl/api/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, to: cleanPhone, message: smsText, sender }),
      });
      await fbLog('INFO', '🎁 Kod nagrody wyslany SMS (platnosc online)', { phone, stamps, code });
    } else {
      await fbLog('WARN', 'autoGrantLoyaltyReward: brak tokenu SMSAPI — kod utworzony, SMS NIE wyslany', { phone, stamps, code });
    }
  } catch (e) {
    await fbLog('ERROR', 'autoGrantLoyaltyReward exception', { message: e.message });
  }
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
      await autoGrantLoyaltyReward(order.phone, matchCust.stamps);
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

// Bezpieczna aktualizacja zamówienia: znajdź klucz po numerze zamówienia, odczytaj
// zamówienie z ETag i zapisz zmiany TYLKO jeśli pod tym kluczem nadal jest to samo,
// niezmienione zamówienie (if-match). Wcześniej był tu ślepy PATCH pod klucz
// znaleziony chwilę wcześniej — gdy panel w tym samym momencie przestawił klucze
// zamówień, PATCH tworzył osierocony wpis, a prawdziwe zamówienie zostawało bez
// potwierdzenia płatności. Przy konflikcie szukamy zamówienia od nowa.
// Zwraca zaktualizowane zamówienie (albo null, jeśli się nie udało).
async function safeUpdateOrder(orderId, fields) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const resp = await fetch(`${FB_URL}/orders.json${FB_SECRET?'?auth='+FB_SECRET:''}`);
    const orders = await resp.json();
    if (!orders || typeof orders !== 'object') {
      await fbLog('WARN', 'Brak zamowien w Firebase', { fetchStatus: resp.status });
      return null;
    }
    const matchingKeys = Object.keys(orders).filter(key => orders[key] && orders[key].id === orderId);
    await fbLog('INFO', 'updateOrderStatus szukam', { orderId, znaleziono: matchingKeys.length, klucze: matchingKeys, proba: attempt });
    if (matchingKeys.length === 0) {
      await fbLog('WARN', 'Nie znaleziono zamowienia', { orderId, dostepneId: Object.values(orders).map(o=>o&&o.id).slice(0,10) });
      return null;
    }
    // Numery zamówień są losowe (5 cyfr), więc przy kolizji wybierz najnowsze —
    // właśnie opłacane zamówienie jest zawsze tym ostatnio złożonym
    matchingKeys.sort((a, b) => (orders[b].timestamp || 0) - (orders[a].timestamp || 0));
    if (matchingKeys.length > 1) {
      await fbLog('WARN', 'Kilka zamowien z tym samym numerem — aktualizuje najnowsze', { orderId, klucze: matchingKeys });
    }

    const key = matchingKeys[0];
    const url = `${FB_URL}/orders/${key}.json${FB_SECRET?'?auth='+FB_SECRET:''}`;
    const getResp = await fetch(url, { headers: { 'X-Firebase-ETag': 'true' } });
    const etag = getResp.headers.get('etag');
    const current = await getResp.json();
    if (!current || current.id !== orderId) continue; // klucz zdążył się zmienić — szukaj od nowa

    const updated = Object.assign({}, current, fields);
    const putResp = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'if-match': etag },
      body: JSON.stringify(updated),
    });
    await fbLog('INFO', 'Firebase update', { key, pola: Object.keys(fields), updateStatus: putResp.status, proba: attempt });
    if (putResp.status === 412) continue; // ktoś zmienił zamówienie w międzyczasie — od nowa
    if (!putResp.ok) return null;
    return updated;
  }
  await fbLog('ERROR', 'safeUpdateOrder: nie udalo sie zapisac po 5 probach', { orderId, pola: Object.keys(fields) });
  return null;
}

// Aktualizuj status zamówienia w Firebase
async function updateOrderStatus(orderId, status, extraFields) {
  try {
    return await safeUpdateOrder(orderId, Object.assign({ status }, extraFields || {}));
  } catch(e) {
    await fbLog('ERROR', 'Blad aktualizacji Firebase', { message: e.message });
    return null;
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

    await fbLog('INFO', 'register: proba rejestracji platnosci', { orderId, amount, email, phone });

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
        await fbLog('INFO', 'register: sukces — token otrzymany', { orderId, sessionId, amount: amountGrosze });
        return res.status(200).json({
          token: data.data.token, sessionId,
          payUrl: `${BASE_URL}/trnRequest/${data.data.token}`,
          sandbox: SANDBOX,
        });
      }
      await fbLog('WARN', 'register: P24 nie zwrocilo tokenu', { orderId, sessionId, status: resp.status, raw: data });
      return res.status(500).json({ error: data.error||'Blad rejestracji', code: resp.status, raw: data });
    } catch(e) {
      await fbLog('ERROR', 'register: wyjatek podczas rejestracji', { orderId, message: e.message });
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
        const paidOrder = await updateOrderStatus(orderNum, 'paid', { paymentConfirmed: true, paidAt: new Date().toISOString() });

        // Przyznaj pieczątkę — na podstawie zamówienia zapisanego chwilę wcześniej
        try {
          if (paidOrder) {
            const granted = await grantStampForOrder(paidOrder);
            if (granted) {
              // Oznacz na zamówieniu, że pieczątka już poszła — inaczej panel doliczy
              // drugą, gdy obsługa oznaczy zamówienie jako "Zrealizowane"
              await safeUpdateOrder(orderNum, { stampGranted: true });
            }
          } else {
            await fbLog('WARN', 'grantStamp: nie znaleziono zamowienia', { orderNum });
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
