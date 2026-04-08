// ════════════════════════════════════════════════════════
// HIRSCHÓWKA BISTRO — Firebase Sync v3
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
    return urls.reduce(function(p, url) {
      return p.then(function() {
        return new Promise(function(res, rej) {
          if (document.querySelector('script[src="' + url + '"]')) { res(); return; }
          var s = document.createElement('script');
          s.src = url; s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });
      });
    }, Promise.resolve());
  }

  loadScripts([
    'https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/9.22.0/firebase-database-compat.js',
    'https://www.gstatic.com/firebasejs/9.22.0/firebase-auth-compat.js',
  ]).then(function() {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    var db   = firebase.database();
    var auth = firebase.auth();

    auth.signInAnonymously().catch(function(e) {
      console.warn('[Firebase] Auth:', e.message);
    });

    var path     = window.location.pathname;
    var isPanel  = path.includes('panel');
    var isApp    = path.includes('app');
    var isClient = !isPanel && !isApp;

    // ── STRONA KLIENTA ──
    if (isClient) {
      // Czytaj dane konfiguracyjne z Firebase
      ['menu','daily-dish','kitchen-day','promos','coupons','addons','zones'].forEach(function(key) {
        db.ref(key).on('value', function(snap) {
          var val = snap.val();
          if (val === null) return;
          localStorage.setItem(key, JSON.stringify(val));
          if (key==='menu' && window.buildMenu) { window.buildMenu(); window.buildCatTabs(); }
          if (key==='daily-dish' && window.renderDaily) window.renderDaily();
          if (key==='kitchen-day' && window.renderKitchen) window.renderKitchen();
          if (key==='promos' && window.renderAdminPromos) window.renderAdminPromos();
        });
      });

      // Przechwytuj zapis zamówień — wyślij do Firebase natychmiast
      var _origSet = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function(key, value) {
        _origSet(key, value);
        if (key === 'orders') {
          try {
            var parsed = JSON.parse(value);
            db.ref('orders').set(parsed).then(function() {
              console.log('[Firebase] Zamowienie wyslane ✓');
            }).catch(function(e) {
              console.warn('[Firebase] Blad zapisu:', e.message);
            });
          } catch(e) {}
        }
      };
      console.log('[Firebase] Klient aktywny');
    }

    // ── PANEL ADMINA ──
    if (isPanel) {
      // ZAMÓWIENIA: nasłuchuj Firebase i aktualizuj panel bezpośrednio
      db.ref('orders').on('value', function(snap) {
        var val = snap.val();
        var freshArr = [];
        if (val !== null && val !== undefined) {
          freshArr = Array.isArray(val) ? val : Object.values(val);
          freshArr = freshArr.filter(function(o) { return o && o.id; });
        }

        console.log('[Firebase] Odebrano zamowienia:', freshArr.length);

        // Zapisz do localStorage
        try {
          localStorage.setItem('orders', JSON.stringify(freshArr));
        } catch(e) {}

        // Aktualizuj panel — czekaj aż panel się załaduje
        function updatePanel() {
          if (typeof renderOrders === 'function') {
            // Globalny zakres — var orders jest dostępne
            try { eval('orders = freshArr'); } catch(e) {}
            renderOrders();
            if (typeof updateAlarm === 'function') updateAlarm();
            if (typeof renderDashboard === 'function') renderDashboard();
          } else {
            setTimeout(updatePanel, 100);
          }
        }
        setTimeout(updatePanel, 50);
      });

      // Synchronizuj dane panelu do Firebase gdy się zmieniają
      function hookW() {
        if (typeof W === 'function' || window.W) {
          var target = window.W || W;
          var orig = target;
          window.W = function(key, val) {
            // Zapisz do localStorage
            localStorage.setItem(key, JSON.stringify(val));
            // Wyślij do Firebase (nie orders — orders zarządzane przez panel)
            if (key !== 'orders') {
              db.ref(key).set(val).catch(function(){});
            } else {
              // Dla orders — wyślij tylko jeśli to zmiana statusu (nie czyścimy)
              if (val && val.length > 0) {
                db.ref(key).set(val).catch(function(){});
              }
            }
          };
          console.log('[Firebase] Panel hook aktywny');
        } else {
          setTimeout(hookW, 200);
        }
      }
      hookW();

      // Obserwuj zmiany konfiguracji panelu i pushuj do Firebase
      var configKeys = ['menu','daily-dish','kitchen-day','promos','coupons','addons','zones','customers'];
      configKeys.forEach(function(key) {
        var last = localStorage.getItem(key);
        setInterval(function() {
          var now = localStorage.getItem(key);
          if (now !== last && now !== null) {
            last = now;
            try { db.ref(key).set(JSON.parse(now)).catch(function(){}); } catch(e) {}
          }
        }, 1000);
      });

      console.log('[Firebase] Panel aktywny');
    }

    // ── APLIKACJA PWA ──
    if (isApp) {
      ['menu','daily-dish','promos','customers'].forEach(function(key) {
        db.ref(key).on('value', function(snap) {
          var val = snap.val();
          if (val === null) return;
          localStorage.setItem(key, JSON.stringify(val));
        });
      });
      var _origSet = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function(key, value) {
        _origSet(key, value);
        if (key === 'orders') {
          try { db.ref('orders').set(JSON.parse(value)).catch(function(){}); } catch(e) {}
        }
      };
      console.log('[Firebase] App aktywna');
    }

    // Status połączenia
    db.ref('.info/connected').on('value', function(snap) {
      var online = snap.val() === true;
      var el = document.getElementById('firebase-status');
      if (el) el.textContent = online ? '🟢' : '🔴';
      console.log('[Firebase]', online ? 'Online' : 'Offline', '|', isPanel ? 'PANEL' : isApp ? 'APP' : 'KLIENT');
    });

    window._firebaseReady = true;
    window._firebase = { db: db };

  }).catch(function(err) {
    console.error('[Firebase] Blad:', err);
  });
})();
