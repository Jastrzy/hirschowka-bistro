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
    return a.filter(function(o){ return o && o.id; });
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
        localStorage.setItem('orders', JSON.stringify(arr));
        if (typeof window.onFirebaseOrders === 'function') {
          window.onFirebaseOrders(arr);
        }
      });

      // Synchronizuj localStorage → Firebase co 1s
      var cfg_keys = ['menu','daily-dish','kitchen-day','promos','coupons','addons','zones','customers','orders'];
      var last = {};
      cfg_keys.forEach(function(k) { last[k] = localStorage.getItem(k); });

      // Jednorazowy push wszystkich kluczy przy starcie panelu
      // (żeby Firebase miał aktualne dane nawet bez edycji)
      setTimeout(function() {
        cfg_keys.forEach(function(k) {
          var val = localStorage.getItem(k);
          if (val !== null) {
            try { db.ref(k).set(JSON.parse(val)).catch(function(){}); } catch(e) {}
          }
        });
        console.log('[FB] Initial push done ✓');
      }, 2000);

      setInterval(function() {
        cfg_keys.forEach(function(k) {
          var now = localStorage.getItem(k);
          if (now !== null && now !== last[k]) {
            last[k] = now;
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
        'kitchen-day': function() { if(window.renderKitchen) window.renderKitchen(); },
        'promos':      function() { if(window.renderAdminPromos) window.renderAdminPromos(); if(window.renderAdminTicker) window.renderAdminTicker(); },
        'coupons':     null,
        'addons':      null,
        'zones':       null
      };

      Object.keys(read_keys).forEach(function(k) {
        db.ref(k).on('value', function(snap) {
          var val = snap.val();
          if (!val) return;
          localStorage.setItem(k, JSON.stringify(val));
          if (read_keys[k]) read_keys[k]();
        });
      });

      // Przechwytuj zapis zamówień → wyślij do Firebase natychmiast
      var _orig = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function(key, value) {
        _orig(key, value);
        if (key === 'orders') {
          try {
            db.ref('orders').set(JSON.parse(value)).then(function() {
              console.log('[FB] Zamowienie wyslane ✓');
            }).catch(function(e) {
              console.warn('[FB] Blad zapisu:', e.message);
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

      var _orig = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function(key, value) {
        _orig(key, value);
        if (key === 'orders') {
          try { db.ref('orders').set(JSON.parse(value)).catch(function(){}); } catch(e) {}
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
