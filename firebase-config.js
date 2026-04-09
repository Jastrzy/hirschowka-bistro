// HIRSCHÓWKA BISTRO — Firebase Sync FINAL
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

  function getArr(val) {
    if (!val) return [];
    var arr = Array.isArray(val) ? val : Object.values(val);
    return arr.filter(function(o){ return o && o.id; });
  }

  function loadScript(url, cb) {
    var s = document.createElement('script');
    s.src = url;
    s.onload = cb;
    s.onerror = cb;
    document.head.appendChild(s);
  }

  loadScript('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js', function() {
  loadScript('https://www.gstatic.com/firebasejs/9.22.0/firebase-database-compat.js', function() {
  loadScript('https://www.gstatic.com/firebasejs/9.22.0/firebase-auth-compat.js', function() {

    if (!firebase.apps.length) firebase.initializeApp(CFG);
    var db = firebase.database();
    firebase.auth().signInAnonymously().catch(function(){});

    // Udostępnij globalnie
    window._firebase = { db: db };
    window._firebaseReady = true;

    var path = window.location.pathname;
    var isPanel  = path.indexOf('panel') >= 0;
    var isApp    = path.indexOf('app') >= 0;
    var isClient = !isPanel && !isApp;

    // ═══ PANEL ═══
    if (isPanel) {
      // Nasłuchuj zamówień w czasie rzeczywistym
      db.ref('orders').on('value', function(snap) {
        var arr = getArr(snap.val());
        console.log('[FB] Zamowienia:', arr.length);
        // Wywołaj callback panelu jeśli istnieje
        if (typeof window.onFirebaseOrders === 'function') {
          window.onFirebaseOrders(arr);
        }
      });

      // Synchronizuj zmiany panelu do Firebase (obserwuj localStorage)
      var keys = ['menu','daily-dish','kitchen-day','promos','coupons','addons','zones','customers','orders'];
      var last = {};
      keys.forEach(function(k){ last[k] = localStorage.getItem(k); });

      setInterval(function() {
        keys.forEach(function(k) {
          var now = localStorage.getItem(k);
          if (now !== null && now !== last[k]) {
            last[k] = now;
            try {
              var val = JSON.parse(now);
              // Dla orders — wyślij tylko gdy niepusta lub celowo czyszczona
              db.ref(k).set(val).catch(function(){});
            } catch(e) {}
          }
        });
      }, 1000);

      console.log('[FB] Panel aktywny');
    }

    // ═══ KLIENT ═══
    if (isClient) {
      // Czytaj konfigurację z Firebase
      ['menu','daily-dish','kitchen-day','promos','coupons','addons','zones'].forEach(function(k) {
        db.ref(k).on('value', function(snap) {
          var val = snap.val();
          if (!val) return;
          localStorage.setItem(k, JSON.stringify(val));
          if (k==='menu' && window.buildMenu) { window.buildMenu(); window.buildCatTabs(); }
          if (k==='daily-dish' && window.renderDaily) window.renderDaily();
          if (k==='kitchen-day' && window.renderKitchen) window.renderKitchen();
          if (k==='promos' && window.renderAdminPromos) window.renderAdminPromos();
        });
      });

      // Przechwytuj zapis zamówień → wyślij natychmiast do Firebase
      var _orig = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function(key, value) {
        _orig(key, value);
        if (key === 'orders') {
          try { db.ref('orders').set(JSON.parse(value)).catch(function(){}); } catch(e) {}
          console.log('[FB] Zamowienie wyslane');
        }
      };

      console.log('[FB] Klient aktywny');
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
    }

    // Status połączenia
    db.ref('.info/connected').on('value', function(snap) {
      console.log('[FB]', snap.val() ? 'Online' : 'Offline', '-', isPanel?'PANEL':isApp?'APP':'KLIENT');
    });

  }); // auth loaded
  }); // database loaded
  }); // app loaded

})();
