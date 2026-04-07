// ════════════════════════════════════════════════════════
// HIRSCHÓWKA BISTRO — Firebase Realtime Sync v2
// ════════════════════════════════════════════════════════

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCUxzOaz6ZkgmGg9FmIoamR77N2mALayh8",
  authDomain:        "hirschowka-bistro.firebaseapp.com",
  databaseURL:       "https://hirschowka-bistro-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "hirschowka-bistro",
  storageBucket:     "hirschowka-bistro.firebasestorage.app",
  messagingSenderId: "885932311557",
  appId:             "1:885932311557:web:235c065b0eba7e0cafc86c"
};

(function() {
  'use strict';

  function loadScripts(urls) {
    return urls.reduce((p, url) => p.then(() => new Promise((res, rej) => {
      if (document.querySelector('script[src="' + url + '"]')) { res(); return; }
      const s = document.createElement('script');
      s.src = url; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    })), Promise.resolve());
  }

  const SCRIPTS = [
    'https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/9.22.0/firebase-database-compat.js',
    'https://www.gstatic.com/firebasejs/9.22.0/firebase-auth-compat.js',
  ];

  loadScripts(SCRIPTS).then(function() {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);

    const db   = firebase.database();
    const auth = firebase.auth();

    auth.signInAnonymously().catch(function(e) {
      console.warn('[Firebase] Auth:', e.message);
    });

    const path    = window.location.pathname;
    const isPanel = path.includes('panel');
    const isApp   = path.includes('app');
    const isClient = !isPanel && !isApp;

    function lsGet(key) {
      try { return JSON.parse(localStorage.getItem(key)); } catch(e) { return null; }
    }

    function fbListen(key, onUpdate) {
      db.ref(key).on('value', function(snap) {
        const val = snap.val();
        if (val === null) return;
        const current = localStorage.getItem(key);
        const incoming = JSON.stringify(val);
        if (incoming !== current) {
          localStorage.setItem(key, incoming);
          if (onUpdate) onUpdate(val);
        }
      });
    }

    function lsWatch(key) {
      let last = localStorage.getItem(key);
      setInterval(function() {
        const now = localStorage.getItem(key);
        if (now !== last && now !== null) {
          last = now;
          try { db.ref(key).set(JSON.parse(now)).catch(function(){}); } catch(e) {}
        }
      }, 800);
    }

    // ── STRONA KLIENTA ──
    if (isClient) {
      console.log('[Firebase] Klient: połączono');
      fbListen('menu',        function() { if (window.buildMenu) { window.buildMenu(); window.buildCatTabs(); } });
      fbListen('daily-dish',  function() { if (window.renderDaily) window.renderDaily(); });
      fbListen('kitchen-day', function() { if (window.renderKitchen) window.renderKitchen(); });
      fbListen('promos',      function() { if (window.renderAdminPromos) window.renderAdminPromos(); });
      fbListen('coupons', null);
      fbListen('addons', null);
      fbListen('zones', null);

      // Przechwytuj localStorage.setItem — gdy klient zapisze zamówienie, wyślij do Firebase
      var _orig = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function(key, value) {
        _orig(key, value);
        if (key === 'orders') {
          try {
            db.ref('orders').set(JSON.parse(value)).catch(function(e) {
              console.warn('[Firebase] Orders write error:', e.message);
            });
            console.log('[Firebase] Zamowienie wyslane do Firebase');
          } catch(e) {}
        }
      };
    }

    // ── PANEL ADMINA ──
    if (isPanel) {
      console.log('[Firebase] Panel: polaczono, nasluchuje zamowien...');

      db.ref('orders').on('value', function(snap) {
        const val = snap.val();
        var freshArr = [];
        if (val !== null && val !== undefined) {
          freshArr = Array.isArray(val) ? val : Object.values(val);
          freshArr = freshArr.filter(function(o) { return o && o.id; });
        }

        // Zapisz do localStorage
        localStorage.setItem('orders', JSON.stringify(freshArr));

        // Zaktualizuj zmienną orders w pamięci panelu i odśwież UI
        // Używamy window aby dostać się do zmiennej globalnej panelu
        window._fbOrders = freshArr;

        // Odśwież panel — wywołaj funkcje panelu jeśli są dostępne
        setTimeout(function() {
          if (window.renderOrders) {
            // Nadpisz globalną zmienną orders jeśli istnieje
            if (typeof window.orders !== 'undefined') window.orders = freshArr;
            window.renderOrders();
          }
          if (window.updateAlarm) window.updateAlarm();
          if (window.renderDashboard) window.renderDashboard();
        }, 50);

        console.log('[Firebase] Zamowienia:', freshArr.length, 'szt.');
      });

      // Hook funkcji W() — każdy zapis panelu idzie też do Firebase
      function hookW() {
        if (window.W) {
          var _origW = window.W;
          window.W = function(key, val) {
            _origW(key, val);
            db.ref(key).set(val).catch(function(){});
          };
          console.log('[Firebase] Hook W() aktywny');
        } else {
          setTimeout(hookW, 200);
        }
      }
      hookW();

      var writeKeys = ['menu','daily-dish','kitchen-day','promos','coupons','addons','zones','customers'];
      writeKeys.forEach(lsWatch);
    }

    // ── APLIKACJA PWA ──
    if (isApp) {
      console.log('[Firebase] App: polaczono');
      fbListen('menu',       function() { if (window.buildMenuContent) window.buildMenuContent(); });
      fbListen('daily-dish', function() { if (window.renderDailyDish) window.renderDailyDish(); });
      fbListen('promos',     function() { if (window.renderPromos) window.renderPromos(); });
      fbListen('customers',  null);

      var _orig = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function(key, value) {
        _orig(key, value);
        if (key === 'orders') {
          try { db.ref('orders').set(JSON.parse(value)).catch(function(){}); } catch(e) {}
        }
      };
    }

    db.ref('.info/connected').on('value', function(snap) {
      var online = snap.val() === true;
      var el = document.getElementById('firebase-status');
      if (el) el.textContent = online ? '🟢 Online' : '🔴 Offline';
      if (!online) console.warn('[Firebase] Offline');
      else console.log('[Firebase] Online. Tryb:', isPanel ? 'PANEL' : isApp ? 'APP' : 'KLIENT');
    });

    window._firebase = { db: db, auth: auth };
    window._firebaseReady = true;

  }).catch(function(err) {
    console.error('[Firebase] Blad ladowania SDK:', err);
  });

})();
