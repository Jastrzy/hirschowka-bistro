// HIRSCHÓWKA BISTRO — Firebase Sync v4
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
  function loadScripts(urls, cb) {
    var i = 0;
    function next() {
      if (i >= urls.length) { cb(); return; }
      var s = document.createElement('script');
      s.src = urls[i++]; s.onload = next; s.onerror = next;
      document.head.appendChild(s);
    }
    next();
  }

  loadScripts([
    'https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/9.22.0/firebase-database-compat.js',
    'https://www.gstatic.com/firebasejs/9.22.0/firebase-auth-compat.js'
  ], function() {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    var db = firebase.database();
    firebase.auth().signInAnonymously().catch(function(){});

    var path = window.location.pathname;
    var isPanel  = path.indexOf('panel') !== -1;
    var isApp    = path.indexOf('app') !== -1;
    var isClient = !isPanel && !isApp;

    window._firebase = { db: db };

    // ── PANEL ──
    if (isPanel) {
      // Nasłuchuj zamówień — wywołaj callback panelu bezpośrednio
      db.ref('orders').on('value', function(snap) {
        var val = snap.val();
        var arr = [];
        if (val) {
          arr = Array.isArray(val) ? val : Object.values(val);
          arr = arr.filter(function(o){ return o && o.id; });
        }
        console.log('[Firebase] Zamowienia z bazy:', arr.length);

        // Wywołaj callback panelu — panel sam aktualizuje swoją zmienną orders
        if (typeof window.onFirebaseOrders === 'function') {
          window.onFirebaseOrders(arr);
        } else {
          // Panel jeszcze się ładuje — poczekaj i spróbuj ponownie
          setTimeout(function(){
            if (typeof window.onFirebaseOrders === 'function') {
              window.onFirebaseOrders(arr);
            }
          }, 500);
        }
      });

      // Synchronizuj zapisy panelu do Firebase
      // Czekaj aż panel zdefiniuje funkcję W
      var hookAttempts = 0;
      function hookW() {
        if (typeof W === 'function') {
          var orig = W;
          window.W = W = function(key, val) {
            localStorage.setItem(key, JSON.stringify(val));
            if (key !== 'orders') {
              db.ref(key).set(val).catch(function(){});
            } else if (val && val.length > 0) {
              db.ref(key).set(val).catch(function(){});
            }
          };
          console.log('[Firebase] W() hooked');
        } else if (hookAttempts++ < 20) {
          setTimeout(hookW, 250);
        }
      }
      hookW();
      console.log('[Firebase] Panel aktywny');
    }

    // ── KLIENT ──
    if (isClient) {
      // Czytaj konfigurację z Firebase
      ['menu','daily-dish','kitchen-day','promos','coupons','addons','zones'].forEach(function(key) {
        db.ref(key).on('value', function(snap) {
          var val = snap.val();
          if (!val) return;
          localStorage.setItem(key, JSON.stringify(val));
          if (key === 'menu' && window.buildMenu) { window.buildMenu(); window.buildCatTabs(); }
          if (key === 'daily-dish' && window.renderDaily) window.renderDaily();
          if (key === 'kitchen-day' && window.renderKitchen) window.renderKitchen();
          if (key === 'promos' && window.renderAdminPromos) window.renderAdminPromos();
        });
      });
      // Przechwytuj zapis zamówień → wyślij do Firebase
      var _origSet = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function(key, value) {
        _origSet(key, value);
        if (key === 'orders') {
          try { db.ref('orders').set(JSON.parse(value)).catch(function(){}); } catch(e) {}
        }
      };
      console.log('[Firebase] Klient aktywny');
    }

    // ── APP ──
    if (isApp) {
      ['menu','daily-dish','promos','customers'].forEach(function(key) {
        db.ref(key).on('value', function(snap) {
          var val = snap.val();
          if (val) localStorage.setItem(key, JSON.stringify(val));
        });
      });
      var _origSet = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function(key, value) {
        _origSet(key, value);
        if (key === 'orders') {
          try { db.ref('orders').set(JSON.parse(value)).catch(function(){}); } catch(e) {}
        }
      };
    }

    db.ref('.info/connected').on('value', function(snap) {
      console.log('[Firebase]', snap.val() ? 'Online' : 'Offline', '|', isPanel?'PANEL':isApp?'APP':'KLIENT');
    });

    window._firebaseReady = true;
  });
})();
