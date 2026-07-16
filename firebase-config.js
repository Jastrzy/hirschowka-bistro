// HIRSCHÓWKA BISTRO — Firebase Sync FINAL v6
(function() {
  var CFG = {
    apiKey:"AIzaSyCUxzOaz6ZkgmGg9FmIoamR77N2mALayh8",
    authDomain:"hirschowka-bistro.firebaseapp.com",
    databaseURL:"https://hirschowka-bistro-default-rtdb.europe-west1.firebasedatabase.app",
    projectId:"hirschowka-bistro",
    storageBucket:"hirschowka-bistro.firebasestorage.app",
    messagingSenderId:"885932311557",
    appId:"1:885932311557:web:235c065b0eba7e0cafc86c"
  };

  function load(url, cb) {
    var s = document.createElement('script');
    s.src = url; s.onload = cb; s.onerror = cb;
    document.head.appendChild(s);
  }

  function getArr(val) {
    if (!val) return [];
    var a = Array.isArray(val) ? val : Object.values(val);
    // Sortuj po czasie złożenia (id lub timestamp) żeby kolejność była właściwa
    a = a.filter(function(o){ return o && o.id; });
    a.sort(function(a,b){
      var ta = a.timestamp||a.time||a.id||'';
      var tb = b.timestamp||b.time||b.id||'';
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    return a;
  }

  load('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js', function() {
  load('https://www.gstatic.com/firebasejs/9.22.0/firebase-database-compat.js', function() {
  load('https://www.gstatic.com/firebasejs/9.22.0/firebase-auth-compat.js', function() {

    if (!firebase.apps.length) firebase.initializeApp(CFG);
    var db = firebase.database();
    var auth = firebase.auth();

    window._firebase = { db: db };
    window._firebaseReady = true;

    var path = window.location.pathname;
    var isPanelPath = path.indexOf('panel') >= 0;

    if (isPanelPath) {
      // Panel — Firebase Auth email+hasło
      // Jawnie wymuś trwałą sesję (przetrwa zamknięcie karty/przeglądarki, usypianie
      // ekranu) — obronnie, na wypadek gdyby przeglądarka na konkretnym tablecie
      // z jakiegoś powodu nie stosowała tego domyślnie
      auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function(e){
        console.warn('[Auth] Nie udało się ustawić trwałości LOCAL:', e.message);
      });
      // Wywołaj _onAuthReady gdy jest gotowy
      if (typeof window._onAuthReady === 'function') {
        window._onAuthReady(auth);
      } else {
        // _onAuthReady nie jest jeszcze zdefiniowany — poczekaj
        window._fbAuth = auth;
        var _authInterval = setInterval(function(){
          if (typeof window._onAuthReady === 'function') {
            clearInterval(_authInterval);
            window._onAuthReady(auth);
          }
        }, 50);
      }
    } else {
      // Strona klienta i app — loguj anonimowo
      auth.signInAnonymously().catch(function(){});
    }

    var path = window.location.pathname;
    var isPanel  = path.indexOf('panel') >= 0;
    var isApp    = path.indexOf('app') >= 0;
    var isClient = !isPanel && !isApp;

    // ═══ PANEL ═══
    if (isPanel) {
      // Zamówienia real-time → callback panelu
      db.ref('orders').on('value', function(snap) {
        var arr = getArr(snap.val());
        console.log('[FB] Zamowienia:', arr.length);
        // Nie nadpisuj localStorage jeśli panel właśnie zapisywał zamówienia
        var lastWrite = (window._ordersLastWrite || 0);
        if (Date.now() - lastWrite >= 8000) {
          localStorage.setItem('orders', JSON.stringify(arr));
        }
        if (typeof window.onFirebaseOrders === 'function') {
          window.onFirebaseOrders(arr);
        }
      });

      // Menu real-time → aktualizuj panel TYLKO jeśli panel nie ma lokalnych danych
      // (nie nadpisuj gdy obsługa właśnie edytowała menu)
      // Śledź kiedy panel ostatnio zapisał menu lokalnie
      var _trackKeys = ['menu','addons','params','rewards','loyalty-history','cross','customers','coupons','schedule','holidays','sms-campaign-history'];
      var _localWriteTs = {};
      var __origSet = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function(key, value) {
        __origSet(key, value);
        if (_trackKeys.indexOf(key) >= 0) {
          _localWriteTs[key] = Date.now();
        }
      };

      db.ref('menu').on('value', function(snap) {
        var val = snap.val();
        if (!val) return;
        // Nie nadpisuj jeśli panel zapisywał menu w ostatnich 10 sekundach
        var lastWrite = _localWriteTs['menu'] || 0;
        if (Date.now() - lastWrite < 10000) {
          console.log('[FB] Menu: pomijam nadpisanie — lokalny zapis jest świeży');
          return;
        }
        var fresh = JSON.stringify(val);
        var stored = localStorage.getItem('menu');
        if (stored === fresh) return;
        localStorage.setItem('menu', fresh);
        if (window._panelMenuReady) {
          try {
            var arr = Array.isArray(val) ? val : Object.values(val);
            window.menuData = arr.filter(function(d){ return d && d.name; });
            if (typeof window.renderMenu === 'function') window.renderMenu();
            console.log('[FB] Menu zaktualizowane z Firebase ✓');
          } catch(e) {}
        }
      });

      // Historia kampanii SMS — real-time, żeby żadne urządzenie nigdy nie nadpisało
      // prawdziwej historii swoją nieaktualną/pustą lokalną kopią
      db.ref('sms-campaign-history').on('value', function(snap) {
        var val = snap.val();
        var arr = val ? (Array.isArray(val) ? val : Object.values(val)) : [];
        arr = arr.filter(function(h){ return h; });
        var lastWrite = _localWriteTs['sms-campaign-history'] || 0;
        if (Date.now() - lastWrite < 5000) return;
        var fresh = JSON.stringify(arr);
        var stored = localStorage.getItem('sms-campaign-history');
        if (stored === fresh) return;
        localStorage.setItem('sms-campaign-history', fresh);
        if (typeof window.onFirebaseSmsHistory === 'function') {
          window.onFirebaseSmsHistory(arr);
        }
      });

      // Harmonogram (godziny otwarcia) real-time → wcześniej wczytywany TYLKO RAZ przy
      // starcie strony z localStorage, nigdy się nie odświeżał. Edycja na jednym urządzeniu
      // nie docierała do innych, które mogły później nadpisać ją z powrotem starą wersją.
      db.ref('schedule').on('value', function(snap) {
        var val = snap.val();
        if (!val) return;
        var lastWrite = _localWriteTs['schedule'] || 0;
        if (Date.now() - lastWrite < 5000) return;
        var arr = Array.isArray(val) ? val : Object.values(val);
        var fresh = JSON.stringify(arr);
        var stored = localStorage.getItem('schedule');
        if (stored === fresh) return;
        localStorage.setItem('schedule', fresh);
        if (typeof window.onFirebaseSchedule === 'function') {
          window.onFirebaseSchedule(arr);
        }
      });

      // Przerwy w pracy (holidays) — ta sama luka co schedule, ta sama naprawa
      db.ref('holidays').on('value', function(snap) {
        var val = snap.val();
        if (!val) return;
        var lastWrite = _localWriteTs['holidays'] || 0;
        if (Date.now() - lastWrite < 5000) return;
        var arr = Array.isArray(val) ? val : Object.values(val);
        arr = arr.filter(function(h){ return h; });
        var fresh = JSON.stringify(arr);
        var stored = localStorage.getItem('holidays');
        if (stored === fresh) return;
        localStorage.setItem('holidays', fresh);
        if (typeof window.onFirebaseHolidays === 'function') {
          window.onFirebaseHolidays(arr);
        }
      });

      // Historia nagród lojalnościowych — real-time, żeby flaga "zrealizowany" (used)
      // ustawiana transakcją była widoczna wszędzie, i żeby usunięcie z ryzykownej
      // pętli 1s (patrz cfg_keys) nie zostawiło panelu z nieaktualną kopią
      db.ref('loyalty-history').on('value', function(snap) {
        var val = snap.val();
        if (!val) return;
        var lastWrite = _localWriteTs['loyalty-history'] || 0;
        if (Date.now() - lastWrite < 5000) return;
        var arr = Array.isArray(val) ? val : Object.values(val);
        arr = arr.filter(function(h){ return h; });
        var fresh = JSON.stringify(arr);
        var stored = localStorage.getItem('loyalty-history');
        if (stored === fresh) return;
        localStorage.setItem('loyalty-history', fresh);
        if (typeof window.onFirebaseLoyaltyHistory === 'function') {
          window.onFirebaseLoyaltyHistory(arr);
        }
      });

      // Kupony real-time → aktualizuj panel z Firebase (źródło prawdy dla licznika użyć)
      // Bez tego nasłuchu licznik "used" zwiększany transakcją (np. przy realizacji kodu
      // przez klienta lub przy kasie) nie trafiał z powrotem do zmiennej `coupons` w panelu
      db.ref('coupons').on('value', function(snap) {
        var val = snap.val();
        if (!val) return;
        // Nie nadpisuj jeśli panel zapisywał kupony w ostatnich 5 sekundach (np. dodawanie/usuwanie)
        var lastWrite = _localWriteTs['coupons'] || 0;
        if (Date.now() - lastWrite < 5000) return;
        var arr = Array.isArray(val) ? val : Object.values(val);
        arr = arr.filter(function(c){ return c; });
        var fresh = JSON.stringify(arr);
        var stored = localStorage.getItem('coupons');
        if (stored === fresh) return;
        localStorage.setItem('coupons', fresh);
        if (typeof window.onFirebaseCoupons === 'function') {
          window.onFirebaseCoupons(arr);
        }
      });

      // Historia realizacji kodów (WWW + kasa) real-time → tylko odczyt, zapis przez push()
      db.ref('coupon-redemptions').on('value', function(snap) {
        var val = snap.val();
        var arr = val ? (Array.isArray(val) ? val : Object.values(val)) : [];
        arr = arr.filter(function(r){ return r; });
        window.couponRedemptions = arr;
        if (typeof window.renderCouponRedemptions === 'function') {
          window.renderCouponRedemptions();
        }
      });

      // Customers real-time → zawsze aktualizuj z Firebase (źródło prawdy)
      db.ref('customers').on('value', function(snap) {
        var val = snap.val();
        if (!val) return;
        // Nie nadpisuj jeśli panel właśnie zapisywał (np. addStampByPhone) — 60s ochrona
        // 60s daje czas na propagację Firebase między urządzeniami bez ryzyka nadpisania świeżej pieczątki
        var lastWrite = _localWriteTs['customers'] || 0;
        if (Date.now() - lastWrite < 60000) return;
        // Zawsze konwertuj na tablicę — Firebase zwraca obiekt z kluczami
        var arr = Array.isArray(val) ? val : Object.values(val);
        arr = arr.filter(function(c){ return c; });
        var fresh = JSON.stringify(arr);
        var stored = localStorage.getItem('customers');
        if (stored !== fresh) {
          localStorage.setItem('customers', fresh);
        }
        // Wyrenderuj — jeśli panel gotowy od razu, jeśli nie — czekaj
        function doRender() {
          try {
            window.customers = arr;
            if (typeof window.renderCusts === 'function') window.renderCusts();
            console.log('[FB] Klienci zaktualizowani z Firebase ✓', arr.length);
          } catch(e) { console.warn('[FB] renderCusts error', e); }
        }
        if (window._panelMenuReady) {
          doRender();
        } else {
          var _retries = 0;
          var _wait = setInterval(function() {
            _retries++;
            if (window._panelMenuReady || _retries > 40) {
              clearInterval(_wait);
              doRender();
            }
          }, 250);
        }
      });

      // Synchronizuj localStorage → Firebase co 1s (tylko zmiany lokalne)
      // UWAGA: 'customers' jest celowo pominięty — zarządzany wyłącznie przez
      // addStampByPhone() i saveCustomers() bezpośrednio przez db.ref('customers/key').update()
      // Dodanie customers tutaj niszczyłoby strukturę kluczy Firebase (set() zastępuje obiekt tablicą)
      // UWAGA: 'coupons' CELOWO NIE JEST na tej liście.
      // Licznik użyć (`used`) jest teraz zarządzany wyłącznie przez bezpieczne transakcje
      // Firebase (redeemCouponAtomic — panel.html i index.html), a dodawanie/usuwanie
      // kuponów przez admina idzie przez W() (natychmiastowy, bezpośredni zapis).
      // Trzymanie 'coupons' w tej pętli powodowało realny wyścig: pętla potrafiła
      // "odbić" starą, lokalną kopię z powrotem do Firebase i cofnąć świeżo
      // zapisane zwiększenie licznika z innego urządzenia (np. zamówienia klienta).
      // UWAGA: 'loyalty-history' CELOWO NIE JEST na tej liście — ten sam powód co 'coupons':
      // flaga "used" (zrealizowany kod) jest teraz ustawiana bezpieczną transakcją Firebase
      // (markLoyaltyHistoryUsed), a ta pętla mogła cofnąć tę zmianę starą, lokalną kopią.
      // UWAGA: 'sms-campaign-history' CELOWO NIE JEST na tej liście — ten sam powód co
      // 'coupons'/'loyalty-history': zapis idzie bezpośrednim db.ref(...).set() w
      // smsMktSaveHistory(), a ta pętla, bez własnego nasłuchu odświeżającego lokalną
      // kopię, potrafiła nadpisać prawdziwą historię starą/pustą kopią z przeglądarki
      // (dokładnie to spowodowało utratę historii kampanii SMS).
      var cfg_keys = ['menu','menu-cats-order','daily-dish','kitchen-day','promos','addons','params','packaging','zones','delivery-zones','geo-api-key','cross','orders','rewards','smsapi-token','smsapi-sender','sms-tpl-accepted','sms-tpl-ready','sms-tpl-delivering','sms-tpl-rejected','emailjs-key','emailjs-service','emailjs-template','hb_login_email'];
      var last = {};
      cfg_keys.forEach(function(k) { last[k] = localStorage.getItem(k); });

      // Klucze których NIE wolno nadpisać pustą wartością w Firebase
      var _protectedKeys = ['customers','menu','addons','params','cross','rewards','loyalty-history','coupons'];
      // Minimalna liczba elementów wymagana do zapisu dla kluczy tablicowych
      var _minItems = {'customers': 1, 'menu': 1};

      setInterval(function() {
        cfg_keys.forEach(function(k) {
          var now = localStorage.getItem(k);
          if (now !== null && now !== last[k]) {
            // Ochrona — nie nadpisuj Firebase pustą/małą tablicą
            if (_protectedKeys.indexOf(k) >= 0) {
              try {
                var parsed = JSON.parse(now);
                var minCount = _minItems[k] || 0;
                // Jeśli to tablica — sprawdź czy ma wystarczająco elementów
                if (Array.isArray(parsed) && parsed.length < minCount) {
                  console.warn('[FB] Blokada sync: ' + k + ' ma ' + parsed.length + ' elementów — za mało, pomijam');
                  return;
                }
                // Jeśli pusta tablica lub null — sprawdź ile jest w Firebase
                if (!parsed || (Array.isArray(parsed) && parsed.length === 0)) {
                  console.warn('[FB] Blokada sync: ' + k + ' jest pusty — nie nadpisuję Firebase');
                  return;
                }
              } catch(e) { return; }
            }
            last[k] = now;
            _localWriteTs[k] = Date.now();
            try { db.ref(k).set(JSON.parse(now)).catch(function(){}); } catch(e) {}
          }
        });
      }, 1000);

      console.log('[FB] Panel OK');
    }

    // ═══ KLIENT ═══
    if (isClient) {
      // Czytaj konfigurację z Firebase → aktualizuj UI
      var read_keys = {
        'menu':        function() { if(window.buildCatTabs) window.buildCatTabs(); if(window.buildMenu) window.buildMenu(); },
        'menu-cats-order': function() { if(window.buildCatTabs) window.buildCatTabs(); if(window.buildMenu) window.buildMenu(); },
        'bistro-open':     null,
        'daily-dish':  function() { if(window.renderDaily) window.renderDaily(); },
        'kitchen-day': function() { if(window.renderKitchen) window.renderKitchen(); if(window.renderDailyDish) window.renderDailyDish(); if(window.renderDaily) window.renderDaily(); },
        'promos':      function() { if(window.renderAdminPromos) window.renderAdminPromos(); if(window.renderAdminTicker) window.renderAdminTicker(); },
        'coupons':     null,
        'addons':      null,
        'cross':       null,
        'smsapi-token':  null,
        'smsapi-sender': null,
        'emailjs-key':   null,
        'emailjs-service': null,
        'emailjs-template': null,
        'params':      function() { if(window.buildMenu) window.buildMenu(); if(window.buildMenuContent) window.buildMenuContent(); },
        'packaging':   null,
        'loyalty-history': null,
        'rewards':     null,
        'zones':       null,
        'delivery-zones': null,
        'geo-api-key': null
      };

      Object.keys(read_keys).forEach(function(k) {
        db.ref(k).on('value', function(snap) {
          var val = snap.val();
          if (!val) return;
          localStorage.setItem(k, JSON.stringify(val));
          if (read_keys[k]) read_keys[k]();
        });
      });

      // Przechwytuj zapis zamówień → dodaj TYLKO nowe zamówienie (push, nie set)
      // set nadpisałby zmiany statusów zrobione przez panel
      var _lastSentOrderIds = new Set();
      // Udostępnij możliwość ręcznego oznaczenia zamówienia jako "już wysłane" —
      // używane przez placeOrder() w index.html TUŻ PRZED bezpośrednim db.ref('orders').push(),
      // żeby ewentualny późniejszy zapasowy zapis do localStorage (na wypadek błędu sieci,
      // gdy zapis do Firebase w rzeczywistości się udał, tylko obietnica strony klienta
      // zgłosiła błąd) nie wysłał TEGO SAMEGO zamówienia drugi raz jako duplikat.
      window._markOrderSent = function(id){ if(id) _lastSentOrderIds.add(id); };
      var _orig = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function(key, value) {
        _orig(key, value);
        if (key === 'orders') {
          try {
            var arr = JSON.parse(value);
            if (!Array.isArray(arr)) return;
            // Wyślij tylko zamówienia których jeszcze nie wysłaliśmy
            arr.forEach(function(order) {
              if (!order || !order.id) return;
              if (_lastSentOrderIds.has(order.id)) return;
              _lastSentOrderIds.add(order.id);
              // Push dodaje zamówienie bez nadpisywania reszty
              db.ref('orders').push(order).then(function() {
                console.log('[FB] Zamowienie wyslane (push):', order.id);
              }).catch(function(e) {
                console.warn('[FB] Blad zapisu:', e.message);
              });
            });
          } catch(e) {}
        }
      };

      console.log('[FB] Klient OK');
    }

    // ═══ APP ═══
    if (isApp) {
      ['menu','daily-dish','promos','customers'].forEach(function(k) {
        db.ref(k).on('value', function(snap) {
          var val = snap.val();
          if (val) localStorage.setItem(k, JSON.stringify(val));
        });
      });

      var _sentAppOrderIds = new Set();
      var _orig = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function(key, value) {
        _orig(key, value);
        if (key === 'orders') {
          try {
            var arr = JSON.parse(value);
            if (!Array.isArray(arr)) return;
            arr.forEach(function(order) {
              if (!order || !order.id) return;
              if (_sentAppOrderIds.has(order.id)) return;
              _sentAppOrderIds.add(order.id);
              db.ref('orders').push(order).catch(function(){});
            });
          } catch(e) {}
        }
      };

      console.log('[FB] App OK');
    }

    // Status połączenia
    var _disconnectedSince = null;
    db.ref('.info/connected').on('value', function(snap) {
      var online = snap.val() === true;
      console.log('[FB]', online ? '🟢 Online' : '🔴 Offline', '-', isPanel?'PANEL':isApp?'APP':'KLIENT');
      if (isPanelPath) {
        if (!online) {
          if (!_disconnectedSince) _disconnectedSince = Date.now();
        } else {
          _disconnectedSince = null;
        }
      }
    });
    // Watchdog — jeśli panel siedzi bez połączenia z Firebase dłużej niż 90 sekund
    // (np. tablet po dłuższej przerwie, zerwane WiFi bez auto-reconnect), sam się
    // przeładowuje, zamiast czekać aż ktoś zauważy i ręcznie odświeży stronę.
    if (isPanelPath) {
      setInterval(function(){
        if (_disconnectedSince && (Date.now() - _disconnectedSince > 90000)) {
          console.warn('[FB] Brak połączenia od ponad 90s — przeładowuję panel');
          location.reload();
        }
      }, 15000);
    }

  });});});
})();
