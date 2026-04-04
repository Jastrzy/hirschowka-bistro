// ════════════════════════════════════════════════════════
// HIRSCHÓWKA BISTRO — Firebase Realtime Sync
// ════════════════════════════════════════════════════════
//
// INSTRUKCJA KONFIGURACJI:
// 1. Wejdź na https://console.firebase.google.com
// 2. Kliknij "Add project" → wpisz "hirschowka-bistro"
// 3. Wyłącz Google Analytics (niepotrzebne) → Create project
// 4. Kliknij "</>" (Web app) → wpisz nazwę "hirschowka-web" → Register
// 5. Skopiuj obiekt firebaseConfig który pojawi się na ekranie
// 6. Wklej go poniżej zamiast placeholder values
// 7. W Firebase Console → Build → Realtime Database → Create database
//    → Start in TEST MODE → Done
// 8. W Firebase Console → Build → Authentication → Get started
//    → Anonymous → Enable → Save
//
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

// ════════════════════════════════════════════════════════
// CO JEST SYNCHRONIZOWANE:
//
//  orders     → zamówienia (klient → panel, real-time)
//  menu       → menu bistro (panel → klient + app)
//  daily-dish → danie dnia (panel → klient + app)
//  kitchen-day→ kuchnia dnia (panel → klient)
//  promos     → promocje (panel → klient + app)
//  customers  → baza klientów (panel → app)
//  coupons    → kupony (panel → klient)
//  addons     → grupy dodatków (panel → klient)
//  zones      → strefy dostaw (panel → klient)
//
// PRIORYTETY:
//  - Klient składa zamówienie → od razu widoczne w panelu
//  - Panel zmienia menu → od razu widoczne na stronie klienta
//  - Działa OFFLINE — dane cached lokalnie, sync gdy internet wróci
//
// ════════════════════════════════════════════════════════

(function() {
  'use strict';

  // Config jest już uzupełniony prawdziwymi danymi
  const isConfigured = FIREBASE_CONFIG.apiKey && !FIREBASE_CONFIG.apiKey.startsWith('WKLEJ');

  if (!isConfigured) {
    console.warn('[Firebase] Konfiguracja nie jest uzupełniona. Działa tryb localStorage.');
    return;
  }

  // Załaduj Firebase SDK dynamicznie
  const loadFirebase = () => {
    return new Promise((resolve) => {
      if (window.firebase) { resolve(window.firebase); return; }

      const scripts = [
        'https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js',
        'https://www.gstatic.com/firebasejs/9.22.0/firebase-database-compat.js',
        'https://www.gstatic.com/firebasejs/9.22.0/firebase-auth-compat.js',
      ];

      let loaded = 0;
      scripts.forEach(src => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => { loaded++; if (loaded === scripts.length) resolve(window.firebase); };
        document.head.appendChild(s);
      });
    });
  };

  loadFirebase().then(firebase => {
    // Inicjalizuj Firebase
    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }

    const db   = firebase.database();
    const auth = firebase.auth();

    // Zaloguj anonimowo (wymagane dla dostępu do bazy)
    auth.signInAnonymously().catch(e => console.warn('[Firebase] Auth error:', e));

    // ── Wykryj typ strony ──
    const path     = window.location.pathname;
    const isPanel  = path.includes('panel');
    const isApp    = path.includes('app');
    const isClient = !isPanel && !isApp;

    console.log('[Firebase] Połączono. Tryb:', isPanel ? 'PANEL' : isApp ? 'APP' : 'KLIENT');

    // ══════════════════════════════════════════
    // HELPERS
    // ══════════════════════════════════════════

    // Odczyt z Firebase → lokalny localStorage
    function syncFromFirebase(key, callback) {
      db.ref(key).on('value', snap => {
        const val = snap.val();
        if (val !== null) {
          localStorage.setItem(key, JSON.stringify(val));
          if (callback) callback(val);
        }
      });
    }

    // Zapis do Firebase + localStorage jednocześnie
    function syncToFirebase(key, val) {
      localStorage.setItem(key, JSON.stringify(val));
      db.ref(key).set(val).catch(e => console.warn('[Firebase] Write error:', e));
    }

    // Nasłuchuj zmian w localStorage i pushuj do Firebase
    // (dla kodu który używa window.localStorage bezpośrednio)
    function watchLocalStorage(key) {
      const original = localStorage.getItem(key);
      let lastVal = original;

      setInterval(() => {
        const current = localStorage.getItem(key);
        if (current !== lastVal) {
          lastVal = current;
          try {
            const parsed = JSON.parse(current);
            db.ref(key).set(parsed).catch(() => {});
          } catch(e) {}
        }
      }, 1000);
    }

    // ══════════════════════════════════════════
    // STRONA KLIENTA
    // ══════════════════════════════════════════
    if (isClient) {
      // Czyta z Firebase (panel je zapisuje)
      const readKeys = ['menu','daily-dish','kitchen-day','promos','coupons','addons','zones'];
      readKeys.forEach(key => {
        syncFromFirebase(key, () => {
          // Odśwież UI po otrzymaniu danych
          if (key === 'menu' && window.buildMenu) { window.buildMenu(); window.buildCatTabs(); }
          if (key === 'daily-dish' && window.renderDaily) window.renderDaily();
          if (key === 'kitchen-day' && window.renderKitchen) window.renderKitchen();
          if (key === 'promos' && window.renderAdminPromos) window.renderAdminPromos();
        });
      });

      // Nasłuchuje nowych zamówień które składa klient (push do Firebase)
      watchLocalStorage('orders');

      console.log('[Firebase] Klient: nasłuchuję menu/promocji, wysyłam zamówienia');
    }

    // ══════════════════════════════════════════
    // PANEL ADMINA
    // ══════════════════════════════════════════
    if (isPanel) {
      // ZAMÓWIENIA — real-time nasłuchiwanie (klient złożył → alarm w panelu)
      db.ref('orders').on('value', snap => {
        const fresh = snap.val();
        if (fresh === null) return;
        const freshArr = Array.isArray(fresh) ? fresh : Object.values(fresh);
        const local = JSON.stringify(localStorage.getItem('orders'));
        if (JSON.stringify(freshArr) !== local) {
          localStorage.setItem('orders', JSON.stringify(freshArr));
          // Odśwież panel zamówień
          if (window.orders !== undefined) {
            window.orders = freshArr;
            if (window.renderOrders) window.renderOrders();
            if (window.updateAlarm) window.updateAlarm();
          }
        }
      });

      // Menu, promocje, strefy — panel zapisuje → Firebase → klient
      const writeKeys = ['menu','daily-dish','kitchen-day','promos','coupons','addons','zones','customers'];
      writeKeys.forEach(key => watchLocalStorage(key));

      // Nadpisz funkcję W() aby automatycznie syncowała do Firebase
      const originalW = window.W;
      if (originalW) {
        window.W = function(key, val) {
          originalW(key, val); // zachowaj localStorage
          db.ref(key).set(val).catch(() => {});
        };
      }

      console.log('[Firebase] Panel: nasłuchuję zamówień, syncuję dane do klientów');
    }

    // ══════════════════════════════════════════
    // APLIKACJA PWA
    // ══════════════════════════════════════════
    if (isApp) {
      const readKeys = ['menu','daily-dish','promos','customers'];
      readKeys.forEach(key => {
        syncFromFirebase(key, () => {
          if (key === 'menu' && window.buildMenuContent) window.buildMenuContent();
          if (key === 'daily-dish' && window.renderDailyDish) window.renderDailyDish();
          if (key === 'promos' && window.renderPromos) window.renderPromos();
        });
      });

      // Zamówienia z aplikacji → Firebase
      watchLocalStorage('orders');

      console.log('[Firebase] App: nasłuchuję menu/promocji, wysyłam zamówienia');
    }

    // ── Wskaźnik połączenia ──
    db.ref('.info/connected').on('value', snap => {
      const connected = snap.val();
      const indicator = document.getElementById('firebase-status');
      if (indicator) {
        indicator.textContent = connected ? '🟢 Online' : '🔴 Offline';
        indicator.title = connected
          ? 'Połączono z Firebase — dane synchronizowane'
          : 'Brak połączenia — zmiany zapisane lokalnie, zsynchronizują się gdy wróci internet';
      }
      if (!connected) {
        console.warn('[Firebase] Offline — dane zapisywane lokalnie');
      }
    });

    // Eksportuj do window dla debugowania
    window._firebase = { db, auth, syncToFirebase, syncFromFirebase };
    window._firebaseReady = true;

  }).catch(err => {
    console.warn('[Firebase] Nie udało się załadować:', err);
  });

})();
