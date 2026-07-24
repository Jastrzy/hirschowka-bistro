// Hirschówka Bistro — Alert SMS o niezaakceptowanym zamówieniu
// Vercel: api/check-pending-orders.js
//
// Niezależna od panelu "siatka bezpieczeństwa": jeśli zamówienie czeka na
// akceptację (status "pending" / "Do akceptacji") dłużej niż próg czasu,
// wysyła SMS na alarmowe numery telefonów — nawet jeśli żaden panel akurat
// nie jest otwarty/połączony. Wywoływane cyklicznie przez zewnętrzny
// harmonogram (np. cron-job.org), bo Vercel Cron na planie Hobby pozwala
// tylko na 1 uruchomienie dziennie.

const FB_URL    = process.env.FIREBASE_DB_URL || 'https://hirschowka-bistro-default-rtdb.europe-west1.firebasedatabase.app';
const FB_SECRET = process.env.FIREBASE_SECRET;
const ALERT_CRON_SECRET = process.env.ALERT_CRON_SECRET;
const ALERT_PHONE_1 = process.env.ALERT_PHONE_1;
const ALERT_PHONE_2 = process.env.ALERT_PHONE_2;
const THRESHOLD_MINUTES = 3;
const THRESHOLD_MS = THRESHOLD_MINUTES * 60 * 1000;

// Logowanie do Firebase — widoczne w panelu admina i Firebase Console (ten sam
// wzorzec co w p24.js, żeby diagnostyka była w jednym miejscu: p24-logs)
async function fbLog(level, msg, data) {
  const entry = { ts: new Date().toISOString(), level, msg, data: data || null };
  console.log(`[ALERT][${level}]`, msg, data ? JSON.stringify(data) : '');
  try {
    await fetch(`${FB_URL}/p24-logs.json${FB_SECRET ? '?auth=' + FB_SECRET : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
  } catch (e) { /* logowanie nie może wywrócić głównej logiki */ }
}

function normStatus(v) {
  if (!v || v === 'pending' || v === 'new' || v === 'nowe' || v === 'do akceptacji' || v === 'awaiting_payment') return 'pending';
  return v;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Prosta ochrona przed przypadkowym/obcym wywołaniem — jeśli ustawiono
  // ALERT_CRON_SECRET, trzeba go podać jako ?secret=... w adresie wywoływanym
  // przez zewnętrzny harmonogram
  if (ALERT_CRON_SECRET) {
    const provided = (req.query && req.query.secret) || '';
    if (provided !== ALERT_CRON_SECRET) {
      return res.status(401).json({ ok: false, err: 'Brak autoryzacji' });
    }
  }

  try {
    const ordersResp = await fetch(`${FB_URL}/orders.json${FB_SECRET ? '?auth=' + FB_SECRET : ''}`);
    const ordersVal = await ordersResp.json();

    if (!ordersVal || typeof ordersVal !== 'object') {
      return res.status(200).json({ ok: true, checked: 0, alerted: 0 });
    }

    const now = Date.now();
    // Object.entries — nie zakładamy, czy Firebase zwróci tablicę czy obiekt;
    // 'key' to prawdziwy klucz Firebase (do zapisu), 'o.id' to numer zamówienia
    const entries = Object.entries(ordersVal).filter(([, o]) => o && o.id);

    const stuck = entries.filter(([, o]) => {
      return normStatus(o.status) === 'pending' && o.timestamp &&
        (now - o.timestamp > THRESHOLD_MS) && !o.alertSent;
    });

    if (!stuck.length) {
      return res.status(200).json({ ok: true, checked: entries.length, alerted: 0 });
    }

    const phones = [ALERT_PHONE_1, ALERT_PHONE_2].filter(Boolean);

    // Ten sam token/nadawca SMS co reszta systemu (zapisany w Firebase,
    // ustawiany w panelu — nie duplikujemy konfiguracji SMSAPI)
    const tokenResp = await fetch(`${FB_URL}/smsapi-token.json${FB_SECRET ? '?auth=' + FB_SECRET : ''}`);
    const token = await tokenResp.json();
    const senderResp = await fetch(`${FB_URL}/smsapi-sender.json${FB_SECRET ? '?auth=' + FB_SECRET : ''}`);
    const senderVal = await senderResp.json();
    const sender = senderVal || 'Hirschowka';

    if (!token || !phones.length) {
      await fbLog('WARN', 'check-pending-orders: brak tokenu SMSAPI lub numerow alertowych — SMS NIE wyslany', {
        hasToken: !!token, iloscNumerow: phones.length, iloscUtknietych: stuck.length,
      });
      return res.status(200).json({ ok: true, checked: entries.length, alerted: 0, warning: 'brak tokenu lub numerow alertowych' });
    }

    let alerted = 0;
    for (const [key, o] of stuck) {
      const minutes = Math.round((now - o.timestamp) / 60000);
      const customerName = o.customer || ('Klient ' + (o.phone || ''));
      const totalStr = (o.total !== undefined && o.total !== null) ? `${o.total} zl` : 'b/d';
      const smsText = `Hirschowka: zamowienie ${o.id} - ${customerName}, ${totalStr} - czeka na akceptacje juz ${minutes} min! Sprawdz panel.`;

      for (const rawPhone of phones) {
        const cleanPhone = '48' + String(rawPhone).replace(/\s/g, '').replace(/^\+48/, '').replace(/\D/g, '');
        try {
          await fetch('https://www.hirschowkabistro.pl/api/sms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, to: cleanPhone, message: smsText, sender }),
          });
        } catch (e) {
          await fbLog('ERROR', 'check-pending-orders: blad wysylki SMS', { message: e.message, phone: rawPhone, orderId: o.id });
        }
      }

      // Oznacz zamówienie jako zaalarmowane — żeby przy kolejnym sprawdzeniu
      // (za minutę) nie wysłać tego samego SMS-a ponownie
      try {
        await fetch(`${FB_URL}/orders/${key}.json${FB_SECRET ? '?auth=' + FB_SECRET : ''}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alertSent: true }),
        });
      } catch (e) {
        await fbLog('ERROR', 'check-pending-orders: blad zapisu alertSent', { message: e.message, orderId: o.id });
      }

      alerted++;
      await fbLog('WARN', '🚨 Alert SMS: zamowienie zbyt dlugo bez akceptacji', { orderId: o.id, minuty: minutes, iloscNumerow: phones.length });
    }

    return res.status(200).json({ ok: true, checked: entries.length, alerted });
  } catch (e) {
    await fbLog('ERROR', 'check-pending-orders exception', { message: e.message });
    return res.status(500).json({ ok: false, err: e.message });
  }
}
