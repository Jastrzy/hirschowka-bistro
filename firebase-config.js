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
    firebase.auth().signInAnonymously().catch(function(){});

    window._firebase = { db: db };
    window._firebaseReady = true;

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
      var _menuLastWrite = 0; // timestamp ostatniego lokalnego zapisu
      var _origSetItem = localStorage.setItem.bind(localStorage);
      // Śledź kiedy panel ostatnio zapisał menu lokalnie
      var _trackKeys = ['menu','addons','params','rewards','loyalty-history'];
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

      // Customers real-time → aktualizuj panel gdy zaimportowano na innym urządzeniu
      db.ref('customers').on('value', function(snap) {
        var val = snap.val();
        if (!val) return;
        var lastWrite = _localWriteTs['customers'] || 0;
        if (Date.now() - lastWrite < 10000) return; // świeży lokalny zapis
        var stored = localStorage.getItem('customers');
        var fresh = JSON.stringify(val);
        if (stored === fresh) return;
        localStorage.setItem('customers', fresh);
        if (window._panelMenuReady) {
          try {
            var arr = Array.isArray(val) ? val : Object.values(val);
            arr = arr.filter(function(c){ return c; });
            // Zawsze aktualizuj — Firebase jest źródłem prawdy dla klientów
            window.customers = arr;
            if (typeof window.renderCusts === 'function') window.renderCusts();
            console.log('[FB] Klienci zaktualizowani z Firebase ✓', arr.length);
          } catch(e) {}
        }
      });

      // Synchronizuj localStorage → Firebase co 1s (tylko zmiany lokalne)
      var cfg_keys = ['menu','daily-dish','kitchen-day','promos','coupons','addons','params','packaging','zones','delivery-zones','geo-api-key','customers','orders','loyalty-history','rewards'];
      var last = {};
      cfg_keys.forEach(function(k) { last[k] = localStorage.getItem(k); });

      setInterval(function() {
        cfg_keys.forEach(function(k) {
          var now = localStorage.getItem(k);
          if (now !== null && now !== last[k]) {
            last[k] = now;
            // Oznacz jako lokalny zapis
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
        'menu':        function() { if(window.buildMenu){window.buildMenu();window.buildCatTabs();} },
        'daily-dish':  function() { if(window.renderDaily) window.renderDaily(); },
        'kitchen-day': function() { if(window.renderKitchen) window.renderKitchen(); if(window.renderDailyDish) window.renderDailyDish(); if(window.renderDaily) window.renderDaily(); },
        'promos':      function() { if(window.renderAdminPromos) window.renderAdminPromos(); if(window.renderAdminTicker) window.renderAdminTicker(); },
        'coupons':     null,
        'addons':      null,
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
    db.ref('.info/connected').on('value', function(snap) {
      var online = snap.val() === true;
      console.log('[FB]', online ? '🟢 Online' : '🔴 Offline', '-', isPanel?'PANEL':isApp?'APP':'KLIENT');
    });

  });});});
})();
