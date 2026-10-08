// Hirschówka Bistro — operacje strony klienta wymagające dostępu do bazy
// Vercel: api/client.js
//
// Strona klienta (index.html, lojalnosc.html, app.html) NIE czyta już sama
// całych list z Firebase (klienci, kupony, historia nagród, zamówienia). Robi
// to ten serwer — z pełnym dostępem (FIREBASE_SECRET) — i zwraca przeglądarce
// TYLKO to, czego potrzebuje (np. imię i liczbę pieczątek, a nie całą bazę).
// Dzięki temu reguły bazy mogą zabronić anonimowym odwiedzającym odczytu
// danych osobowych, tokenów SMS itd., a zamówienia dalej działają.
//
// Akcje (POST, JSON; health także GET): health, coupon-check, coupon-redeem,
// customer-register, loyalty, newsletter, order-status, order-payment-failed.

const FB_URL    = process.env.FIREBASE_DB_URL || 'https://hirschowka-bistro-default-rtdb.europe-west1.firebasedatabase.app';
const FB_SECRET = process.env.FIREBASE_SECRET;

function fbUrl(path) {
  return `${FB_URL}/${path}.json${FB_SECRET ? '?auth=' + FB_SECRET : ''}`;
}

async function fbGet(path) {
  const resp = await fetch(fbUrl(path));
  if (!resp.ok) throw new Error(`Firebase GET ${path}: ${resp.status}`);
  return resp.json();
}

async function fbWrite(method, path, body) {
  const resp = await fetch(fbUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Firebase ${method} ${path}: ${resp.status}`);
  return resp.json();
}

// Odpowiednik transaction() z SDK, dla REST: odczyt z ETag, zmiana, zapis tylko
// jeśli nikt w międzyczasie nie zmienił tego samego miejsca (if-match). Przy
// konflikcie (412) próbujemy ponownie ze świeżymi danymi. updateFn zwraca
// undefined, żeby przerwać bez zapisu (tak jak w SDK).
async function fbTransaction(path, updateFn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const getResp = await fetch(fbUrl(path), { headers: { 'X-Firebase-ETag': 'true' } });
    if (!getResp.ok) throw new Error(`Firebase GET ${path}: ${getResp.status}`);
    const etag = getResp.headers.get('etag');
    const current = await getResp.json();
    const next = updateFn(current);
    if (next === undefined) return { committed: false, value: current };
    const putResp = await fetch(fbUrl(path), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'if-match': etag },
      body: JSON.stringify(next),
    });
    if (putResp.status === 412) continue;
    if (!putResp.ok) throw new Error(`Firebase PUT ${path}: ${putResp.status}`);
    return { committed: true, value: next };
  }
  throw new Error('Zbyt wiele równoczesnych zmian — spróbuj ponownie');
}

// Firebase zwraca listę jako tablicę albo obiekt z kluczami — zawsze pary [klucz, wartość]
function entriesOf(val) {
  if (!val || typeof val !== 'object') return [];
  return Object.entries(val).filter(([, v]) => v);
}

const normPhone = p => String(p || '').replace(/\s/g, '');
const normEmail = e => String(e || '').toLowerCase().trim();
const isPhone = p => /^(\+48)?[0-9]{9}$/.test(p);
const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 120;
const clip = (s, n) => String(s || '').trim().slice(0, n);

const todayPL = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' }); // RRRR-MM-DD
const nowPL = () => new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' });

async function findCoupon(code) {
  const wanted = String(code || '').trim().toUpperCase();
  if (!wanted) return null;
  const found = entriesOf(await fbGet('coupons')).find(([, c]) => String(c.code || '').toUpperCase() === wanted);
  return found ? { key: found[0], coupon: found[1] } : null;
}

// Te same komunikaty i kolejność sprawdzeń co wcześniej w applyCoupon() w index.html
function couponProblem(c) {
  if (c.exp && c.exp < todayPL()) return 'Ten kupon wygasł.';
  if ((c.used || 0) >= (c.limit || 1)) return 'Kupon został już wykorzystany.';
  return null;
}

async function findCustomer({ phone, email }) {
  const all = entriesOf(await fbGet('customers'));
  const found = phone
    ? all.find(([, c]) => normPhone(c.phone) === phone)
    : all.find(([, c]) => normEmail(c.email) === email);
  return found ? { key: found[0], customer: found[1] } : null;
}

// Zamówienia ze strony mają klucz = numer bez '#'. Starsze/inne mogły trafić pod
// inny klucz, więc w razie braku szukamy po polu id (jak robi to p24.js).
async function findOrder(id) {
  const orderKey = String(id || '').replace('#', '');
  if (!/^[0-9A-Za-z_-]{1,40}$/.test(orderKey)) return null;
  const direct = await fbGet('orders/' + orderKey);
  if (direct && String(direct.id).replace('#', '') === orderKey) return { key: orderKey, order: direct };
  const found = entriesOf(await fbGet('orders')).find(([, o]) => String(o.id).replace('#', '') === orderKey);
  return found ? { key: found[0], order: found[1] } : null;
}

const actions = {
  // Diagnostyka: czy serwer ma FIREBASE_SECRET i czy faktycznie może czytać bazę
  async health() {
    let dbOk = false;
    try { await fbGet('schedule'); dbOk = true; } catch (e) { /* dbOk zostaje false */ }
    return { ok: dbOk, secretConfigured: !!FB_SECRET, dbOk };
  },

  // Sprawdzenie kodu w koszyku — zwraca tylko dane tego jednego kuponu
  async 'coupon-check'(body) {
    const hit = await findCoupon(body.code);
    if (!hit) return { ok: false, msg: 'Nieprawidłowy kod kuponu.' };
    const problem = couponProblem(hit.coupon);
    if (problem) return { ok: false, msg: problem };
    const c = hit.coupon;
    return {
      ok: true,
      coupon: {
        code: c.code, disc: c.disc, min: c.min || 0, cats: c.cats || '', exp: c.exp || '',
        loyaltyReward: !!c.loyaltyReward, rewardName: c.rewardName || '',
      },
    };
  },

  // Atomowe zużycie kodu przy składaniu zamówienia (dawne redeemCouponAtomic +
  // markLoyaltyHistoryUsed z index.html)
  async 'coupon-redeem'(body) {
    const hit = await findCoupon(body.code);
    if (!hit) return { ok: false, msg: 'Ten kod właśnie wygasł lub został w pełni wykorzystany.' };
    const result = await fbTransaction('coupons/' + hit.key, c => {
      if (!c || couponProblem(c)) return undefined;
      return Object.assign({}, c, { used: (c.used || 0) + 1, usedAt: nowPL() });
    });
    if (!result.committed) return { ok: false, msg: 'Ten kod właśnie wygasł lub został w pełni wykorzystany.' };

    // Nagroda lojalnościowa — oznacz wpis w historii jako zrealizowany, żeby panel
    // (zakładka Lojalność) pokazywał realizację. Błąd tutaj nie cofa użycia kodu.
    if (hit.coupon.loyaltyReward) {
      try {
        const entry = entriesOf(await fbGet('loyalty-history')).find(([, h]) => h.code === hit.coupon.code);
        if (entry) {
          await fbWrite('PATCH', 'loyalty-history/' + entry[0], { used: true, usedAt: nowPL() });
        }
      } catch (e) {
        console.warn('[client] loyalty-history: błąd oznaczania jako zrealizowany:', e.message);
      }
    }
    return { ok: true };
  },

  // Rejestracja klienta przy zamówieniu (jeśli telefonu jeszcze nie ma w bazie)
  async 'customer-register'(body) {
    const phone = normPhone(body.phone);
    if (!isPhone(phone)) return { ok: false, msg: 'Nieprawidłowy numer telefonu' };
    const email = isEmail(normEmail(body.email)) ? clip(body.email, 120) : '';
    if (await findCustomer({ phone })) return { ok: true, created: false };
    await fbWrite('POST', 'customers', {
      name: clip(body.name, 100) || ('Klient ' + phone),
      phone, email,
      sms: false,
      emailMkt: !!body.emailMkt,
      stamps: 0, totalStamps: 0, visits: 0, spent: 0, last: '',
      registeredAt: todayPL(),
    });
    return { ok: true, created: true };
  },

  // Karta stałego gościa — tylko imię i pieczątki, nigdy cała baza
  async loyalty(body) {
    const query = String(body.query || '').trim();
    const byEmail = query.includes('@');
    const lookup = byEmail ? { email: normEmail(query) } : { phone: normPhone(query) };
    if (byEmail ? !isEmail(lookup.email) : !isPhone(lookup.phone)) return { ok: true, found: false };
    const hit = await findCustomer(lookup);
    if (!hit) return { ok: true, found: false };
    const c = hit.customer;
    return {
      ok: true, found: true,
      firstName: String(c.name || '').split(' ')[0],
      stamps: c.stamps || 0,
      visits: c.visits || 0,
    };
  },

  // Zapis do newslettera (SMS albo e-mail) — dopisuje zgodę albo tworzy klienta
  async newsletter(body) {
    const byEmail = body.type === 'email';
    const value = byEmail ? normEmail(body.value) : normPhone(body.value);
    if (byEmail ? !isEmail(value) : !isPhone(value)) {
      return { ok: false, msg: byEmail ? 'Nieprawidłowy adres e-mail' : 'Nieprawidłowy numer telefonu' };
    }
    const hit = await findCustomer(byEmail ? { email: value } : { phone: value });
    if (hit) {
      await fbWrite('PATCH', 'customers/' + hit.key, byEmail ? { emailMkt: true } : { sms: true });
      return { ok: true, existing: true };
    }
    await fbWrite('POST', 'customers', {
      name: byEmail ? 'Klient ' + value.split('@')[0] : 'Klient ' + value,
      phone: byEmail ? '' : value,
      email: byEmail ? value : '',
      sms: !byEmail,
      emailMkt: byEmail,
      stamps: 0, totalStamps: 0, visits: 0, spent: 0,
      last: '', registeredAt: todayPL(),
    });
    return { ok: true, existing: false };
  },

  // Status jednego zamówienia (powrót z Przelewy24) — tylko status i to, czy
  // płatność potwierdzono. Samo status === 'paid' nie wystarcza: jeśli obsługa
  // zdąży przyjąć zamówienie w panelu, zanim klient wróci z banku, status jest
  // już 'accepted'. Znacznik paymentConfirmed (ustawia go webhook P24 w p24.js)
  // panel zachowuje przy zmianach statusu.
  async 'order-status'(body) {
    const hit = await findOrder(body.id);
    if (!hit) return { ok: true, found: false, status: null, paid: false };
    const o = hit.order;
    return { ok: true, found: true, status: o.status || '', paid: o.paymentConfirmed === true || o.status === 'paid' };
  },

  // Płatność nie doszła w czasie — oznacz jako nieudaną, ale TYLKO jeśli zamówienie
  // nadal czeka na płatność (webhook P24 mógł je w międzyczasie potwierdzić)
  async 'order-payment-failed'(body) {
    const hit = await findOrder(body.id);
    if (!hit) return { ok: true, changed: false };
    const result = await fbTransaction('orders/' + hit.key, o => {
      if (!o || (o.status || '') !== 'awaiting_payment') return undefined;
      return Object.assign({}, o, { status: 'payment_failed', paymentFailedAt: new Date().toISOString() });
    });
    return { ok: true, changed: result.committed };
  },
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  // GET tylko dla health — żeby dało się go sprawdzić, otwierając adres w przeglądarce
  const isHealthGet = req.method === 'GET' && req.query.action === 'health';
  if (req.method !== 'POST' && !isHealthGet) return res.status(405).json({ ok: false, msg: 'Method not allowed' });

  const action = actions[req.query.action];
  if (!action) return res.status(400).json({ ok: false, msg: 'Nieznana akcja' });

  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    return res.status(200).json(await action(body));
  } catch (e) {
    console.error('[client]', req.query.action, e.message);
    return res.status(500).json({ ok: false, msg: 'Błąd serwera. Spróbuj ponownie.' });
  }
};
