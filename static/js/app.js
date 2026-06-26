/**
 * VoltRoute — EV Charging Route Planner
 * Frontend Application Logic
 *
 * Sections:
 * 1. App State & Init
 * 2. Navigation
 * 3. Authentication
 * 4. Map (Google Maps + Leaflet fallback)
 * 5. Route Planning
 * 6. Charging Stations
 * 7. Car Management
 * 8. History & Favorites
 * 9. UI Utilities
 */

// ═══════════════════════════════════════════════════════════════
// 1. APP STATE & INITIALIZATION
// ═══════════════════════════════════════════════════════════════

const state = {
  user: null,
  currentRoute: null,
  theme: localStorage.getItem('theme') || 'dark',
  mapMode: window.GOOGLE_MAPS_KEY ? 'google' : 'leaflet',
  leafletMap: null,
  googleMap: null,
  directionsRenderer: null,
  routePolyline: null,
  stationMarkers: [],
};

const CACHE_TTL_MS = 30 * 60 * 1000;

function normalizeCacheText(value = '') {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getCacheKey(prefix, ...parts) {
  return `${prefix}:${parts.map(part => normalizeCacheText(part)).join('|')}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 0) {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const effectiveType = connection?.effectiveType || '';
  const slowNetwork = ['slow-2g', '2g'].includes(effectiveType);
  const finalTimeout = timeoutMs || (slowNetwork ? 15000 : 9000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), finalTimeout);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function saveCacheEntry(key, payload) {
  try {
    localStorage.setItem(key, JSON.stringify({
      savedAt: Date.now(),
      payload,
    }));
  } catch (e) {
    console.warn('Could not save cache entry:', e);
  }
}

function readCacheEntry(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.payload) return null;
    const age = Date.now() - (parsed.savedAt || 0);
    if (age > CACHE_TTL_MS) return null;
    return parsed.payload;
  } catch (e) {
    return null;
  }
}

function saveRouteCache(from, to, data) {
  const key = getCacheKey('ev_route_cache', from, to);
  saveCacheEntry(key, data);
}

function getRouteCache(from, to) {
  const key = getCacheKey('ev_route_cache', from, to);
  return readCacheEntry(key);
}

function saveStationCache(lat, lng, radius, stations) {
  const key = getCacheKey('ev_station_cache', lat, lng, radius);
  saveCacheEntry(key, { lat, lng, radius, stations });

  try {
    const recent = JSON.parse(localStorage.getItem('ev_recent_station_cache') || '[]');
    const next = [{ lat, lng, radius, stations, savedAt: Date.now() }, ...recent.filter(item => !(item.lat === lat && item.lng === lng && item.radius === radius))].slice(0, 5);
    localStorage.setItem('ev_recent_station_cache', JSON.stringify(next));
  } catch (e) {}
}

function getStationCache(lat, lng, radius) {
  const key = getCacheKey('ev_station_cache', lat, lng, radius);
  const exact = readCacheEntry(key);
  if (exact) return exact;

  try {
    const recent = JSON.parse(localStorage.getItem('ev_recent_station_cache') || '[]');
    return recent.find(item => Math.abs(item.lat - lat) < 0.01 && Math.abs(item.lng - lng) < 0.01 && Number(item.radius) === Number(radius)) || null;
  } catch (e) {
    return null;
  }
}

function getLatestStationCache() {
  try {
    const recent = JSON.parse(localStorage.getItem('ev_recent_station_cache') || '[]');
    return recent[0] || null;
  } catch (e) {
    return null;
  }
}

function updateNetworkStatus() {
  const isOnline = navigator.onLine;
  document.documentElement.dataset.network = isOnline ? 'online' : 'offline';
  if (!isOnline) {
    showToast('Connection seems unstable. Saved results will be used if needed.', 'error');
  }
}

// Run on page load
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(state.theme);
  checkAuth();
  populateEvSelectors();
  initSidebarControls();
  ensureStationsMapContainer();
  updateNetworkStatus();
  window.addEventListener('online', updateNetworkStatus);
  window.addEventListener('offline', updateNetworkStatus);
});

/** Ensure a `#stationsMapView` exists inside the first stations map frame and hide embedded iframes */
function ensureStationsMapContainer() {
  try {
    const frame = document.querySelector('.station-map-frame');
    if (!frame) return;
    // hide any iframe child
    const iframe = frame.querySelector('iframe');
    if (iframe) iframe.style.display = 'none';
    let container = document.getElementById('stationsMapView');
    if (!container) {
      container = document.createElement('div');
      container.id = 'stationsMapView';
      container.style.width = '100%';
      container.style.minHeight = '360px';
      container.style.height = '100%';
      frame.appendChild(container);
    }
  } catch (e) { console.warn('ensureStationsMapContainer failed', e); }
}

/** Initialize sidebar toggle controls (desktop and mobile) - IMPROVED VERSION */
function initSidebarControls() {
  const sidebar = document.getElementById('sidebar');
  const mobileBtn = document.getElementById('mobileMenuBtn');

  if (!sidebar || !mobileBtn) return;

  // Track overlay state
  let overlayActive = false;

  function setExpanded(expanded) {
    mobileBtn.setAttribute('aria-expanded', String(!!expanded));
  }

  function closeSidebar() {
    sidebar.classList.remove('open');
    setExpanded(false);
    mobileBtn.classList.remove('is-active');
    removeOverlay();
  }

  function removeOverlay() {
    const overlay = document.getElementById('sidebarOverlay');
    if (overlay && overlayActive) {
      overlay.style.opacity = '0';
      setTimeout(() => {
        overlay.remove();
        overlayActive = false;
      }, 200);
    }
  }

  function createOverlay() {
    if (overlayActive) return;
    const overlay = document.createElement('div');
    overlay.id = 'sidebarOverlay';
    overlay.className = 'sidebar-overlay';
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.2s ease';
    document.body.appendChild(overlay);
    overlayActive = true;
    
    // Trigger fade-in
    requestAnimationFrame(() => {
      overlay.style.opacity = '1';
    });

    // Close sidebar on overlay click
    overlay.addEventListener('click', (e) => {
      e.stopPropagation();
      closeSidebar();
    }, { once: true });
  }

  function toggleSidebar(e) {
    e && e.preventDefault();
    e && e.stopPropagation();
    
    const isOpen = sidebar.classList.toggle('open');
    setExpanded(isOpen);
    
    if (isOpen) {
      mobileBtn.classList.add('is-active');
      mobileBtn.setAttribute('aria-label', 'Close menu');
      
      if (window.innerWidth <= 768) {
        createOverlay();
      }
    } else {
      closeSidebar();
    }
  }

  // Attach click handlers with proper delegation
  mobileBtn.addEventListener('click', toggleSidebar, { passive: false });

  // Close on nav item click (mobile)
  document.querySelectorAll('.nav-item').forEach(navItem => {
    navItem.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        closeSidebar();
      }
    });
  });

  // Close on outside click (mobile)
  document.addEventListener('click', (ev) => {
    if (!sidebar.classList.contains('open') || window.innerWidth > 768) return;
    
    const isClickInside = sidebar.contains(ev.target) || 
                         mobileBtn.contains(ev.target);
    
    if (!isClickInside) {
      closeSidebar();
    }
  });

  // Resize handler: close sidebar on desktop breakpoint
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768 && sidebar.classList.contains('open')) {
      removeOverlay();
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// 2. NAVIGATION
// ═══════════════════════════════════════════════════════════════

/** Show a panel and update nav state */
function showPanel(panelId) {
  // Hide all panels
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  // Show selected
  const panel = document.getElementById(`panel-${panelId}`);
  if (panel) panel.classList.add('active');

  // Activate nav button
  const navBtn = document.querySelector(`[data-panel="${panelId}"]`);
  if (navBtn) navBtn.classList.add('active');

  // Update page title
  const titles = {
    planner: 'Route Planner',
    stations: 'Charging Stations',
    history: 'History & Favorites',
    algorithms: 'Advanced Algorithms',
  };
  document.getElementById('pageTitle').textContent = titles[panelId] || 'VoltRoute';

  // Load charging map on demand for better performance
  if (panelId === 'stations') {
    loadChargingMapLazy();
  }

  // Load data for panel if needed
  if (panelId === 'history' && state.user) {
    loadHistory();
    loadFavorites();
  }

  // Close mobile menu
  document.getElementById('sidebar').classList.remove('open');
}

/** Lazy load the charging map iframe for better performance */
function loadChargingMapLazy() {
  const iframe = document.getElementById('chargingMapIframe');
  const loadingState = document.querySelector('.map-loading-state');
  
  if (!iframe || iframe.src.startsWith('blob:')) return; // Already loaded
  
  // Show loading state
  if (loadingState) {
    loadingState.classList.remove('hidden');
  }
  
  // Load iframe with slight delay for smooth animation
  setTimeout(() => {
    if (iframe) {
      iframe.style.display = '';
      iframe.onload = () => {
        // Hide loading state when iframe loads
        if (loadingState) {
          loadingState.classList.add('hidden');
        }
      };
      // Set src to trigger loading if not already set
      if (!iframe.src || iframe.src === '') {
        iframe.src = 'https://map.openchargemap.io/?mode=embedded';
      }
    }
  }, 100);
}

// ═══════════════════════════════════════════════════════════════
// 3. AUTHENTICATION
// ═══════════════════════════════════════════════════════════════

/** Check current session on load */
async function checkAuth() {
  try {
    const res = await fetch('/api/me', { credentials: 'include' });
    const data = await res.json();
    if (data.logged_in) {
      setUserUI(data.user);
    }
  } catch (e) {
    console.warn('Auth check failed:', e);
  }
}

/** Login with email/password */
async function login() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';

  if (!email || !password) { errEl.textContent = 'Please fill in all fields.'; return; }

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();

    if (!res.ok) { errEl.textContent = data.error; return; }

    setUserUI(data.user);
    closeModal('loginModal');
    showToast('Welcome back, ' + data.user.name + '! ⚡', 'success');
    loadCars();  // Auto-load saved cars
  } catch (e) {
    errEl.textContent = 'Network error. Please try again.';
  }
}

/** Register new account */
async function register() {
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  const errEl = document.getElementById('regError');
  errEl.textContent = '';

  if (!name || !email || !password) { errEl.textContent = 'Please fill in all fields.'; return; }

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, email, password }),
    });
    const data = await res.json();

    if (!res.ok) { errEl.textContent = data.error; return; }

    setUserUI(data.user);
    closeModal('loginModal');
    showToast('Account created! Welcome to VoltRoute 🚗', 'success');
  } catch (e) {
    errEl.textContent = 'Network error. Please try again.';
  }
}

/** Logout */
async function logout() {
  await fetch('/api/logout', { method: 'POST', credentials: 'include' });
  state.user = null;
  state.primaryCar = null;
  document.getElementById('authNav').style.display = 'block';
  document.getElementById('userNav').style.display = 'none';
  document.getElementById('guestPill').style.display = 'flex';
  showToast('Logged out.', '');
}

/** Update UI for logged in user */
function setUserUI(user) {
  state.user = user;
  document.getElementById('authNav').style.display = 'none';
  document.getElementById('userNav').style.display = 'block';
  document.getElementById('userName').textContent = user.name;
  document.getElementById('userEmail').textContent = user.email;
  document.getElementById('userAvatar').textContent = user.name.charAt(0).toUpperCase();
  document.getElementById('guestPill').style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════
// 4. EV SELECTORS
// ═══════════════════════════════════════════════════════════════

const EV_DATA = {
  Tesla: [
    { model: 'Model 3', range_km: 513, battery_kwh: 57.5, fast_charge_kw: 250, efficiency: 4.8, segment: 'Compact EV' },
    { model: 'Model Y', range_km: 455, battery_kwh: 60, fast_charge_kw: 250, efficiency: 5.1, segment: 'SUV EV' },
    { model: 'Model S', range_km: 652, battery_kwh: 100, fast_charge_kw: 250, efficiency: 5.4, segment: 'Luxury Sedan' },
    { model: 'Cybertruck', range_km: 515, battery_kwh: 123, fast_charge_kw: 250, efficiency: 6.8, segment: 'Pickup EV' },
  ],
  Nissan: [
    { model: 'Leaf', range_km: 240, battery_kwh: 40, fast_charge_kw: 100, efficiency: 5.8, segment: 'City EV' },
    { model: 'Ariya', range_km: 329, battery_kwh: 63, fast_charge_kw: 130, efficiency: 5.1, segment: 'Crossover EV' },
  ],
  Honda: [
    { model: 'e', range_km: 222, battery_kwh: 35.5, fast_charge_kw: 80, efficiency: 5.3, segment: 'Urban EV' },
    { model: 'Prologue', range_km: 483, battery_kwh: 85, fast_charge_kw: 155, efficiency: 5.6, segment: 'Mid-size SUV' },
  ],
  Toyota: [
    { model: 'bZ4X', range_km: 406, battery_kwh: 71.4, fast_charge_kw: 150, efficiency: 5.7, segment: 'Compact SUV' },
    { model: 'Prius Prime', range_km: 1_000, battery_kwh: 13.6, fast_charge_kw: 3.3, efficiency: 7.3, segment: 'PHEV Hybrid' },
  ],
  Ford: [
    { model: 'Mustang Mach-E', range_km: 491, battery_kwh: 91, fast_charge_kw: 150, efficiency: 5.4, segment: 'Performance SUV' },
    { model: 'F-150 Lightning', range_km: 515, battery_kwh: 131, fast_charge_kw: 150, efficiency: 6.5, segment: 'Electric Pickup' },
  ],
  Hyundai: [
    { model: 'Ioniq 5', range_km: 430, battery_kwh: 77.4, fast_charge_kw: 220, efficiency: 4.9, segment: 'Family EV' },
    { model: 'Kona Electric', range_km: 415, battery_kwh: 64, fast_charge_kw: 100, efficiency: 5.4, segment: 'City SUV' },
    { model: 'Ioniq 6', range_km: 614, battery_kwh: 77.4, fast_charge_kw: 233, efficiency: 4.8, segment: 'Luxury Sedan' },
  ],
  Kia: [
    { model: 'EV6', range_km: 510, battery_kwh: 77.4, fast_charge_kw: 233, efficiency: 4.9, segment: 'Fast-Charge EV' },
    { model: 'Niro EV', range_km: 407, battery_kwh: 64.8, fast_charge_kw: 85, efficiency: 5.2, segment: 'Compact SUV' },
    { model: 'EV9', range_km: 541, battery_kwh: 99.8, fast_charge_kw: 210, efficiency: 5.5, segment: '3-Row SUV' },
  ],
  Volkswagen: [
    { model: 'ID.4', range_km: 350, battery_kwh: 77, fast_charge_kw: 135, efficiency: 5.3, segment: 'Compact SUV' },
    { model: 'ID.3', range_km: 426, battery_kwh: 58, fast_charge_kw: 120, efficiency: 4.9, segment: 'Hatchback EV' },
    { model: 'ID. Buzz', range_km: 400, battery_kwh: 86, fast_charge_kw: 170, efficiency: 5.7, segment: 'Electric Van' },
  ],
  BMW: [
    { model: 'i4', range_km: 590, battery_kwh: 83.9, fast_charge_kw: 200, efficiency: 4.8, segment: 'Performance Sedan' },
    { model: 'iX', range_km: 600, battery_kwh: 105.2, fast_charge_kw: 200, efficiency: 5.0, segment: 'Luxury SUV' },
    { model: 'i3', range_km: 260, battery_kwh: 42.2, fast_charge_kw: 50, efficiency: 5.1, segment: 'Urban EV' },
  ],
  Mercedes: [
    { model: 'EQS', range_km: 700, battery_kwh: 107.8, fast_charge_kw: 200, efficiency: 5.0, segment: 'Luxury Sedan' },
    { model: 'EQA', range_km: 500, battery_kwh: 66.5, fast_charge_kw: 100, efficiency: 5.0, segment: 'Compact SUV' },
    { model: 'EQB', range_km: 419, battery_kwh: 66.5, fast_charge_kw: 100, efficiency: 5.2, segment: 'Family SUV' },
    { model: 'EQE', range_km: 660, battery_kwh: 90.6, fast_charge_kw: 170, efficiency: 5.0, segment: 'Executive Sedan' },
  ],
  Audi: [
    { model: 'Q4 e-tron', range_km: 520, battery_kwh: 82, fast_charge_kw: 175, efficiency: 5.1, segment: 'Premium SUV' },
    { model: 'e-tron GT', range_km: 488, battery_kwh: 93, fast_charge_kw: 270, efficiency: 4.9, segment: 'Grand Touring EV' },
    { model: 'e-tron', range_km: 420, battery_kwh: 95, fast_charge_kw: 150, efficiency: 5.3, segment: 'Luxury SUV' },
  ],
  Porsche: [
    { model: 'Taycan', range_km: 430, battery_kwh: 93.4, fast_charge_kw: 270, efficiency: 4.7, segment: 'Sport EV' },
    { model: 'Macan Electric', range_km: 613, battery_kwh: 100, fast_charge_kw: 270, efficiency: 5.1, segment: 'Performance SUV' },
  ],
  Lucid: [
    { model: 'Air', range_km: 837, battery_kwh: 118, fast_charge_kw: 300, efficiency: 4.9, segment: 'Luxury Sedan' },
    { model: 'Gravity', range_km: 720, battery_kwh: 118, fast_charge_kw: 300, efficiency: 5.1, segment: 'Luxury SUV' },
  ],
  Rivian: [
    { model: 'R1T', range_km: 560, battery_kwh: 135, fast_charge_kw: 220, efficiency: 6.4, segment: 'Adventure Pickup' },
    { model: 'R1S', range_km: 640, battery_kwh: 135, fast_charge_kw: 220, efficiency: 6.0, segment: 'Adventure SUV' },
  ],
  Polestar: [
    { model: '2', range_km: 470, battery_kwh: 78, fast_charge_kw: 155, efficiency: 4.8, segment: 'Performance Hatch' },
    { model: '3', range_km: 610, battery_kwh: 111, fast_charge_kw: 250, efficiency: 5.0, segment: 'Luxury SUV' },
  ],
  Peugeot: [
    { model: 'e-208', range_km: 340, battery_kwh: 50, fast_charge_kw: 100, efficiency: 5.0, segment: 'City Hatch' },
    { model: 'e-3008', range_km: 700, battery_kwh: 98, fast_charge_kw: 160, efficiency: 5.4, segment: 'Family SUV' },
  ],
  Renault: [
    { model: 'Megane E-Tech', range_km: 470, battery_kwh: 60, fast_charge_kw: 130, efficiency: 4.8, segment: 'Family Hatch' },
    { model: 'Scenic E-Tech', range_km: 625, battery_kwh: 87, fast_charge_kw: 150, efficiency: 5.1, segment: 'Family SUV' },
  ],
  BYD: [
    { model: 'Dolphin', range_km: 340, battery_kwh: 44.9, fast_charge_kw: 88, efficiency: 5.0, segment: 'City EV' },
    { model: 'Atto 3', range_km: 420, battery_kwh: 60.5, fast_charge_kw: 80, efficiency: 5.3, segment: 'Compact SUV' },
    { model: 'Seal', range_km: 570, battery_kwh: 82.5, fast_charge_kw: 150, efficiency: 4.8, segment: 'Sport Sedan' },
  ],
  Volvo: [
    { model: 'XC40 Recharge', range_km: 420, battery_kwh: 78, fast_charge_kw: 150, efficiency: 5.1, segment: 'Compact SUV' },
    { model: 'EX30', range_km: 480, battery_kwh: 69, fast_charge_kw: 134, efficiency: 5.0, segment: 'Urban SUV' },
  ],
  Jeep: [
    { model: 'Wagoneer S', range_km: 500, battery_kwh: 100, fast_charge_kw: 200, efficiency: 5.8, segment: 'Luxury SUV' },
    { model: 'Avenger EV', range_km: 400, battery_kwh: 54, fast_charge_kw: 100, efficiency: 5.1, segment: 'City SUV' },
  ],
  Mini: [
    { model: 'Electric', range_km: 230, battery_kwh: 32.6, fast_charge_kw: 50, efficiency: 5.1, segment: 'Mini City EV' },
  ],
  Genesis: [
    { model: 'GV60', range_km: 470, battery_kwh: 77.4, fast_charge_kw: 233, efficiency: 4.9, segment: 'Luxury SUV' },
  ],
  Skoda: [
    { model: 'Enyaq', range_km: 510, battery_kwh: 82, fast_charge_kw: 135, efficiency: 5.0, segment: 'Family SUV' },
    { model: 'Citigo e iV', range_km: 165, battery_kwh: 36.8, fast_charge_kw: 40, efficiency: 5.2, segment: 'City EV' },
  ],
  Mitsubishi: [
    { model: 'Outlander PHEV', range_km: 900, battery_kwh: 20, fast_charge_kw: 5, efficiency: 7.0, segment: 'PHEV SUV' },
    { model: 'Eclipse Cross PHEV', range_km: 820, battery_kwh: 13.8, fast_charge_kw: 5, efficiency: 6.8, segment: 'PHEV Crossover' },
  ],
  Subaru: [
    { model: 'Solterra', range_km: 460, battery_kwh: 71.4, fast_charge_kw: 150, efficiency: 5.2, segment: 'Adventure SUV' },
  ],
  MG: [
    { model: 'ZS EV', range_km: 320, battery_kwh: 50.3, fast_charge_kw: 80, efficiency: 5.1, segment: 'Budget SUV' },
    { model: 'Windsor EV', range_km: 460, battery_kwh: 64, fast_charge_kw: 100, efficiency: 5.3, segment: 'Family SUV' },
  ],
  Tata: [
    { model: 'Nexon EV', range_km: 312, battery_kwh: 30.2, fast_charge_kw: 60, efficiency: 5.0, segment: 'Budget SUV' },
    { model: 'Tiago EV', range_km: 250, battery_kwh: 19.2, fast_charge_kw: 50, efficiency: 4.9, segment: 'City EV' },
  ],
  Mahindra: [
    { model: 'BE 6', range_km: 500, battery_kwh: 79, fast_charge_kw: 175, efficiency: 5.3, segment: 'Premium SUV' },
    { model: 'XUV.e8', range_km: 550, battery_kwh: 80, fast_charge_kw: 175, efficiency: 5.5, segment: 'Flagship SUV' },
  ],
  Xiaomi: [
    { model: 'SU7', range_km: 700, battery_kwh: 101, fast_charge_kw: 220, efficiency: 4.9, segment: 'Performance Sedan' },
  ],
  Zeekr: [
    { model: '001', range_km: 580, battery_kwh: 100, fast_charge_kw: 220, efficiency: 4.9, segment: 'Luxury Fastback' },
    { model: 'X', range_km: 440, battery_kwh: 86, fast_charge_kw: 200, efficiency: 5.1, segment: 'Compact SUV' },
  ],
  VinFast: [
    { model: 'VF 8', range_km: 450, battery_kwh: 87.7, fast_charge_kw: 150, efficiency: 5.3, segment: 'Family SUV' },
    { model: 'VF 9', range_km: 500, battery_kwh: 123.5, fast_charge_kw: 200, efficiency: 5.4, segment: 'Large SUV' },
  ],
  Faraday: [
    { model: 'FF 91', range_km: 600, battery_kwh: 130, fast_charge_kw: 250, efficiency: 5.2, segment: 'Luxury Sedan' },
  ],
  Aptera: [
    { model: 'Solar EV', range_km: 640, battery_kwh: 60, fast_charge_kw: 100, efficiency: 4.3, segment: 'Solar Efficiency EV' },
    { model: '2e', range_km: 400, battery_kwh: 42, fast_charge_kw: 80, efficiency: 4.6, segment: 'Ultra-Light EV' },
  ],
  Karma: [
    { model: 'GS-6', range_km: 380, battery_kwh: 78, fast_charge_kw: 150, efficiency: 5.1, segment: 'Luxury SUV' },
  ],
  'Aston Martin': [
    { model: 'Rapide E', range_km: 320, battery_kwh: 65, fast_charge_kw: 150, efficiency: 4.8, segment: 'Luxury Grand Tourer' },
  ],
  'Rolls-Royce': [
    { model: 'Spectre', range_km: 530, battery_kwh: 102, fast_charge_kw: 195, efficiency: 5.0, segment: 'Ultra-Luxury Coupe' },
  ],
};

function populateEvSelectors() {
  const brandSelect = document.getElementById('carBrandSelect');
  const modelSelect = document.getElementById('carModelSelect');
  if (!brandSelect || !modelSelect) return;

  brandSelect.innerHTML = '<option value="">Choose a brand</option>' + Object.keys(EV_DATA).map(brand => `<option value="${brand}">${brand}</option>`).join('');

  brandSelect.onchange = () => {
    const models = EV_DATA[brandSelect.value] || [];
    modelSelect.innerHTML = models.length
      ? models.map(item => `<option value="${item.model}" data-range="${item.range_km}" data-battery="${item.battery_kwh}" data-charge="${item.fast_charge_kw}" data-segment="${item.segment || 'EV'}">${item.model}</option>`).join('')
      : '<option value="">Select a model</option>';
    updateEvProfile(models[0] || null, brandSelect.value);
  };

  modelSelect.onchange = () => {
    const selectedModel = modelSelect.selectedOptions[0];
    if (!selectedModel) return;
    updateEvProfile({
      model: selectedModel.value,
      range_km: Number(selectedModel.dataset.range || 350),
      battery_kwh: Number(selectedModel.dataset.battery || 60),
      fast_charge_kw: Number(selectedModel.dataset.charge || 120),
      segment: selectedModel.dataset.segment || 'EV'
    }, brandSelect.value);
  };

  modelSelect.innerHTML = '<option value="">Select a model</option>';
  updateEvProfile(null, '');
}

function updateEvProfile(modelInfo, brand) {
  const detailsBox = document.getElementById('evProfileDetails');
  if (!detailsBox) return;

  if (!brand || !modelInfo) {
    detailsBox.innerHTML = '<div class="detail-chip"><span class="detail-label">Tip</span><span class="detail-value">Pick a brand and model to see its projected range and charging profile.</span></div>';
    return;
  }

  document.getElementById('batteryRange').value = modelInfo.range_km || 350;
  detailsBox.innerHTML = `
    <div class="detail-chip"><span class="detail-label">Brand</span><span class="detail-value">${brand}</span></div>
    <div class="detail-chip"><span class="detail-label">Model</span><span class="detail-value">${modelInfo.model}</span></div>
    <div class="detail-chip"><span class="detail-label">Range</span><span class="detail-value">${modelInfo.range_km} km</span></div>
    <div class="detail-chip"><span class="detail-label">Battery</span><span class="detail-value">${modelInfo.battery_kwh} kWh</span></div>
    <div class="detail-chip"><span class="detail-label">Fast charge</span><span class="detail-value">${modelInfo.fast_charge_kw} kW</span></div>
    <div class="detail-chip"><span class="detail-label">Class</span><span class="detail-value">${modelInfo.segment || 'EV'}</span></div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// 4. MAP INITIALIZATION
// ═══════════════════════════════════════════════════════════════

/** Called by Google Maps script callback */
window.initMap = function () {
  const mapEl = document.getElementById('map');
  if (!mapEl) return;

  // Remove placeholder
  document.getElementById('mapPlaceholder').style.display = 'none';

  state.googleMap = new google.maps.Map(mapEl, {
    center: { lat: 20.5937, lng: 78.9629 }, // Default: India
    zoom: 5,
    mapTypeId: 'roadmap',
    styles: getMapStyles(),
    disableDefaultUI: false,
    zoomControl: true,
    streetViewControl: false,
    mapTypeControl: false,
  });

  state.directionsRenderer = new google.maps.DirectionsRenderer({
    map: state.googleMap,
    suppressMarkers: false,
    polylineOptions: {
      strokeColor: '#34d399',
      strokeOpacity: 0.9,
      strokeWeight: 5,
    },
  });

  // Google Places autocomplete
  setupAutocomplete('fromLocation');
  setupAutocomplete('toLocation');
  setupAutocomplete('nearbyLocation');

  // Create a separate Google map for the Stations panel if present
  const stationsMapEl = document.getElementById('stationsMapView');
  if (stationsMapEl && !state.googleStationsMap) {
    state.googleStationsMap = new google.maps.Map(stationsMapEl, {
      center: { lat: 20.5937, lng: 78.9629 },
      zoom: 10,
      styles: getMapStyles(),
      disableDefaultUI: true,
    });
  }
};

/** Leaflet fallback for when Google Maps key is missing */
window.initMapLeaflet = function () {
  if (!window.L) return;
  const mapEl = document.getElementById('map');
  if (!mapEl || mapEl.querySelector('.leaflet-container')) return;

  document.getElementById('mapPlaceholder').style.display = 'none';
  mapEl.style.minHeight = '500px';

  state.leafletMap = L.map(mapEl).setView([20.5937, 78.9629], 5);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(state.leafletMap);

  // Also set up for stations map
  const stationsMapEl = document.getElementById('stationsMapView');
  if (stationsMapEl && !stationsMapEl.querySelector('.leaflet-container')) {
    state.leafletStationsMap = L.map(stationsMapEl).setView([20.5937, 78.9629], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
    }).addTo(state.leafletStationsMap);
  }
};

/** Setup Google Places autocomplete on an input */
function setupAutocomplete(inputId) {
  if (!window.google) return;
  const input = document.getElementById(inputId);
  if (!input) return;
  new google.maps.places.Autocomplete(input, {
    types: ['geocode', 'establishment'],
  });
}

/** Dark map styles for Google Maps */
function getMapStyles() {
  const isDark = state.theme === 'dark';
  if (!isDark) return [];
  return [
    { elementType: 'geometry', stylers: [{ color: '#1a2433' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#0a0e14' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#8a9ab5' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#252f3e' }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#111720' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2c3e50' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0d1420' }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  ];
}

// ═══════════════════════════════════════════════════════════════
// 5. ROUTE PLANNING
// ═══════════════════════════════════════════════════════════════

/** Main route planning function */
async function planRoute() {
  const from = document.getElementById('fromLocation').value.trim();
  const to = document.getElementById('toLocation').value.trim();
  const batteryRange = parseFloat(document.getElementById('batteryRange').value) || 350;
  const currentCharge = parseInt(document.getElementById('currentCharge').value) || 80;

  if (!from || !to) {
    showToast('Please enter both From and To locations.', 'error');
    return;
  }

  const btn = document.querySelector('#panel-planner .btn-primary');
  btn.classList.add('loading');
  btn.innerHTML = '<span class="spinner"></span> Planning...';

  try {
    if (state.mapMode === 'google' && window.google) {
      await planRouteGoogle(from, to, batteryRange, currentCharge);
    } else {
      await planRouteLeaflet(from, to, batteryRange, currentCharge);
    }
  } catch (e) {
    showToast('Route planning failed. Check your inputs.', 'error');
    console.error(e);
  } finally {
    btn.classList.remove('loading');
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      Plan Route`;
  }
}

/** Google Maps routing */
async function planRouteGoogle(from, to, batteryRange, currentCharge) {
  const directionsService = new google.maps.DirectionsService();

  directionsService.route({
    origin: from,
    destination: to,
    travelMode: google.maps.TravelMode.DRIVING,
    drivingOptions: {
      departureTime: new Date(),
      trafficModel: google.maps.TrafficModel.BEST_GUESS,
    },
  }, async (result, status) => {
    if (status !== 'OK') {
      showToast('Could not find route. Try different locations.', 'error');
      return;
    }

    state.directionsRenderer.setDirections(result);

    const leg = result.routes[0].legs[0];
    const distanceKm = leg.distance.value / 1000;
    const durationMin = leg.duration.value / 60;

    // Extract waypoints along route for charging recommendations
    const path = result.routes[0].overview_path;
    const waypoints = path.map(p => ({ lat: p.lat(), lng: p.lng() }));

    // Get smart analysis from backend
    await analyzeAndDisplayRoute(distanceKm, durationMin, batteryRange, currentCharge, waypoints, from, to);
  });
}

/** Leaflet/OpenStreetMap routing using OSRM */
async function planRouteLeaflet(from, to, batteryRange, currentCharge) {
  // Geocode both locations using Nominatim
  const [fromCoords, toCoords] = await Promise.all([
    geocodeNominatim(from),
    geocodeNominatim(to),
  ]);

  if (!fromCoords || !toCoords) {
    showToast('Could not find one or both locations.', 'error');
    return;
  }

  // Get route from OSRM (free routing engine)
  const url = `https://router.project-osrm.org/route/v1/driving/${fromCoords.lng},${fromCoords.lat};${toCoords.lng},${toCoords.lat}?overview=full&geometries=geojson&steps=false`;
  const res = await fetch(url);
  const data = await res.json();

  if (!data.routes || !data.routes[0]) {
    showToast('No route found between these locations.', 'error');
    return;
  }

  const route = data.routes[0];
  const distanceKm = route.distance / 1000;
  const durationMin = route.duration / 60;

  // Draw route on Leaflet map
  if (state.routePolyline) state.routePolyline.remove();

  const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);
  state.routePolyline = L.polyline(coords, {
    color: '#34d399',
    weight: 5,
    opacity: 0.85,
  }).addTo(state.leafletMap);

  // Add start/end markers
  L.marker([fromCoords.lat, fromCoords.lng])
    .bindPopup(`<strong>Start:</strong> ${from}`)
    .addTo(state.leafletMap);

  L.marker([toCoords.lat, toCoords.lng])
    .bindPopup(`<strong>End:</strong> ${to}`)
    .addTo(state.leafletMap);

  state.leafletMap.fitBounds(state.routePolyline.getBounds(), { padding: [30, 30] });

  const waypoints = route.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] }));
  await analyzeAndDisplayRoute(distanceKm, durationMin, batteryRange, currentCharge, waypoints, from, to);
}

/** Geocode a place name using Nominatim */
async function geocodeNominatim(place) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=1`, {
      headers: { 'Accept-Language': 'en' }
    });
    const data = await res.json();
    if (data && data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch (e) { console.error('Geocoding error:', e); }
  return null;
}

/** Call backend for smart analysis and fetch charging stations */
async function analyzeAndDisplayRoute(distanceKm, durationMin, batteryRange, currentCharge, waypoints, from, to) {
  const cacheKey = getRouteCache(from, to);
  let planData = null;

  if (cacheKey && cacheKey.distanceKm === distanceKm && cacheKey.durationMin === durationMin) {
    planData = cacheKey.planData;
  } else {
    try {
      const planRes = await fetchWithTimeout('/api/plan_route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          distance_km: distanceKm,
          battery_range_km: batteryRange,
          current_charge_pct: currentCharge,
          waypoints: waypoints.slice(0, 50), // Limit waypoints
        }),
      });
      planData = await planRes.json();
      if (planData && planData.tip) {
        saveRouteCache(from, to, {
          distanceKm,
          durationMin,
          planData,
        });
      }
    } catch (e) {
      const fallback = getRouteCache(from, to);
      if (fallback && fallback.distanceKm === distanceKm && fallback.durationMin === durationMin) {
        planData = fallback.planData;
        showToast('Using saved route details because the network is slow.', 'error');
      } else {
        showToast('Route analysis could not load right now. Try again when the connection improves.', 'error');
        return;
      }
    }
  }

  state.currentRoute = { from, to, distanceKm, durationMin, planData };

  // Update route summary overlay
  document.getElementById('summaryDistance').textContent = distanceKm.toFixed(1) + ' km';
  document.getElementById('summaryDuration').textContent = formatDuration(durationMin);
  document.getElementById('summaryStops').textContent = planData.stops_needed + ' charge stops';
  document.getElementById('routeSummary').style.display = 'flex';

  // Display smart analysis card
  displayAnalysis(planData, distanceKm, durationMin, batteryRange, currentCharge);

  // Run the strongest combined analysis using the live route data
  if (Array.isArray(waypoints) && waypoints.length > 1) {
    state.currentRoute = {
      from,
      to,
      distanceKm,
      durationMin,
      planData,
      waypoints,
    };
    await runComprehensiveAnalysisFromRoute();
  }

  // Place predicted charging-stop markers along the route (if recommendations provided)
  if (planData && Array.isArray(planData.charging_recommendations) && planData.charging_recommendations.length > 0) {
    try {
      addChargingStopMarkers(planData.charging_recommendations, waypoints);
    } catch (e) { console.warn('Charging marker placement failed:', e); }
  }

  // Fetch charging stations along midpoint of route
  const midIdx = Math.floor(waypoints.length / 2);
  const midpoint = waypoints[midIdx] || waypoints[0];
  if (midpoint) {
    await fetchAndDisplayRouteStations(midpoint.lat, midpoint.lng, Math.max(10, distanceKm / 10));
  }

  const routeSummary = {
    from_location: from,
    to_location: to,
    distance_km: distanceKm,
    duration_min: durationMin,
    charging_stops: planData.stops_needed,
    current_soc: currentCharge,
    safe_range_km: planData.safe_range_km,
    tip: planData.tip,
  };

  saveGuestHistory(routeSummary);

  try {
    await fetch('/api/save_route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(routeSummary),
    });
  } catch (e) {
    console.warn('History save skipped for guest session:', e);
  }
}

/** Render the smart analysis card */
function displayAnalysis(plan, distanceKm, durationMin, batteryRange, currentCharge) {
  const card = document.getElementById('analysisCard');
  const content = document.getElementById('analysisContent');
  card.style.display = 'flex';

  const stopColor = plan.stops_needed === 0 ? 'accent' : plan.stops_needed <= 2 ? 'cyan' : 'amber';
  const availableRange = (currentCharge / 100) * (batteryRange || plan.battery_range_km || 350);
  const estimatedEnergyKwh = Math.max(1, (distanceKm / 100) * 18).toFixed(1);
  const recommendedTopUp = Math.max(20, Math.min(100, Math.ceil((distanceKm / (batteryRange || 350)) * 100 + 10)));

  content.innerHTML = `
    <div class="analysis-tip">${plan.tip}</div>
    <div class="analysis-stats">
      <div class="stat-box">
        <span class="stat-label">Total Distance</span>
        <span class="stat-value">${distanceKm.toFixed(0)} <small style="font-size:0.65em;font-weight:400">km</small></span>
      </div>
      <div class="stat-box">
        <span class="stat-label">Travel Time</span>
        <span class="stat-value cyan">${formatDuration(durationMin)}</span>
      </div>
      <div class="stat-box">
        <span class="stat-label">Available Range</span>
        <span class="stat-value accent">${availableRange.toFixed(0)} km</span>
      </div>
      <div class="stat-box">
        <span class="stat-label">Safe Range</span>
        <span class="stat-value">${plan.safe_range_km} <small style="font-size:0.65em;font-weight:400">km</small></span>
      </div>
      <div class="stat-box">
        <span class="stat-label">Energy Needed</span>
        <span class="stat-value cyan">${estimatedEnergyKwh} kWh</span>
      </div>
      <div class="stat-box">
        <span class="stat-label">Top-up Target</span>
        <span class="stat-value">${recommendedTopUp}%</span>
      </div>
      <div class="stat-box">
        <span class="stat-label">Charge Stops</span>
        <span class="stat-value ${stopColor}">${plan.stops_needed}</span>
      </div>
      <div class="stat-box">
        <span class="stat-label">Battery Range</span>
        <span class="stat-value">${batteryRange || plan.battery_range_km || 350} km</span>
      </div>
    </div>
    <div class="station-summary">You can stop at these charging points along the route. Each stop includes a suggested charge-to level and the expected range you can cover before the next pause.</div>
    ${plan.charging_recommendations.length > 0 ? `
      <div>
        <p style="font-size:0.78rem;font-weight:600;color:var(--text-muted);margin-bottom:0.4rem;text-transform:uppercase;letter-spacing:0.05em;">Recommended Charge Points</p>
        ${plan.charging_recommendations.map((r, idx) => `
          <div class="station-card ${idx === 0 ? 'best' : ''}" style="margin-bottom:0.4rem">
            <div class="station-icon fast ${idx === 0 ? 'best-icon' : ''}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            </div>
            <div class="station-info">
              <p class="station-name">Stop ${r.stop_number} — around ${r.estimated_km_at_stop} km from start ${idx === 0 ? '<span class="best-badge">Best</span>' : ''}</p>
              <p class="station-meta">Charge to ${r.charge_needed_pct}% recommended · plan for ${Math.max(1, Math.round((r.estimated_km_at_stop || 0) / 100))} short charging break(s) on this leg</p>
            </div>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `;
}

/** Fetch charging stations near a point and show in route panel */
async function fetchAndDisplayRouteStations(lat, lng, radiusKm) {
  const radius = Math.min(radiusKm, 30);
  const cached = getStationCache(lat, lng, radius);

  if (cached && Array.isArray(cached.stations)) {
    renderRouteStations(cached.stations, 'Using saved station results for this area.');
  }

  try {
    const res = await fetchWithTimeout(`/api/charging_stations?lat=${lat}&lng=${lng}&radius=${radius}&maxResults=10`);
    const data = await res.json();

    if (data && data.stations && data.stations.length > 0) {
      saveStationCache(lat, lng, radius, data.stations);
      renderRouteStations(data.stations);
    } else if (!cached || !Array.isArray(cached.stations)) {
      document.getElementById('stationsCard').style.display = 'none';
    }
  } catch (e) {
    console.warn('Could not load stations:', e);
    if (cached && Array.isArray(cached.stations)) {
      renderRouteStations(cached.stations, 'Offline mode: showing the latest saved stations.');
    } else {
      showToast('Unable to load stations right now. Try again later.', 'error');
    }
  }
}

function renderRouteStations(stations, note = '') {
  if (!stations || stations.length === 0) {
    document.getElementById('stationsCard').style.display = 'none';
    return;
  }

  const card = document.getElementById('stationsCard');
  const list = document.getElementById('stationsList');
  card.style.display = 'flex';

  list.innerHTML = `
    <p class="station-summary">Found ${stations.length} charging station${stations.length === 1 ? '' : 's'} near this route. ${note || 'These are the best places to stop for a quick top-up.'}</p>
    ${stations.map(s => renderStationCard(s)).join('')}
  `;

  addStationMarkersToMap(stations);
}

// ═══════════════════════════════════════════════════════════════
// 6. CHARGING STATIONS (Nearby Panel)
// ═══════════════════════════════════════════════════════════════

/** Search for nearby stations from the stations panel */
async function findNearbyStations() {
  const locationInput = document.getElementById('nearbyLocation').value.trim();
  const radius = document.getElementById('nearbyRadius').value || 10;

  if (!locationInput) {
    showToast('Enter a location to search.', 'error');
    return;
  }

  showToast('Searching stations...', '');

  let lat, lng;

  // Try to geocode
  const coords = await geocodeNominatim(locationInput);
  if (coords) { lat = coords.lat; lng = coords.lng; }
  else {
    showToast('Location not found.', 'error');
    return;
  }

  await loadStationsAtLocation(lat, lng, radius);
}

/** Use browser geolocation */
function useCurrentLocation() {
  if (!navigator.geolocation) {
    return fallbackToIpLocation('nearbyLocation', 'nearbyRadius');
  }

  showToast('Finding your location…', '');
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude, longitude, accuracy } = pos.coords;
      document.getElementById('nearbyLocation').value = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
      loadStationsAtLocation(latitude, longitude, document.getElementById('nearbyRadius').value || 10);
      showToast(`Location found with ±${Math.round(accuracy)} m accuracy.`, 'success');
    },
    err => {
      console.warn('Geolocation failed, falling back to IP lookup:', err);
      fallbackToIpLocation('nearbyLocation', 'nearbyRadius');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

function useMyLocationForRoute() {
  if (!navigator.geolocation) {
    return fallbackToIpLocation('fromLocation');
  }

  showToast('Detecting your starting point…', '');
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude, longitude } = pos.coords;
      document.getElementById('fromLocation').value = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
      showToast('Starting point set to your current location.', 'success');
    },
    err => {
      console.warn('Route geolocation failed, falling back to IP lookup:', err);
      fallbackToIpLocation('fromLocation');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

function useMyLocationForStations() {
  if (!navigator.geolocation) {
    return fallbackToIpLocation('nearbyLocation', 'nearbyRadius');
  }

  showToast('Finding nearby charging stations…', '');
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude, longitude, accuracy } = pos.coords;
      const nearbyInput = document.getElementById('nearbyLocation');
      if (nearbyInput) nearbyInput.value = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
      centerStationMap(latitude, longitude, 10);
      const radius = document.getElementById('nearbyRadius')?.value || 10;
      if (document.getElementById('nearbyStationsList')) {
        loadStationsAtLocation(latitude, longitude, radius);
      }
      showToast(`Your location is now pinned with ±${Math.round(accuracy)} m accuracy.`, 'success');
    },
    err => {
      console.warn('Stations geolocation failed, falling back to IP lookup:', err);
      fallbackToIpLocation('nearbyLocation', 'nearbyRadius');
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
  );
}

async function fallbackToIpLocation(inputId, radiusId) {
  try {
    showToast('Using network location as a fallback…', '');
    const res = await fetch('https://ipapi.co/json/');
    const data = await res.json();
    if (!data.latitude || !data.longitude) throw new Error('No coordinates received');

    const lat = Number(data.latitude);
    const lng = Number(data.longitude);
    const targetInput = document.getElementById(inputId);

    if (targetInput) {
      targetInput.value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    }

    centerStationMap(lat, lng, 10);

    if (inputId === 'nearbyLocation' && radiusId && document.getElementById('nearbyStationsList')) {
      const radius = document.getElementById(radiusId)?.value || 10;
      await loadStationsAtLocation(lat, lng, radius);
    }

    showToast('Network location loaded. Enable GPS for more precise results.', 'success');
  } catch (e) {
    console.error('IP fallback failed:', e);
    showToast('Location lookup failed. Please allow location access or try again.', 'error');
  }
}

/** Load and display stations at a lat/lng */
async function loadStationsAtLocation(lat, lng, radius) {
  const cached = getStationCache(lat, lng, radius);
  const list = document.getElementById('nearbyStationsList');

  if (cached && Array.isArray(cached.stations)) {
    renderNearbyStations(cached.stations, 'Using saved results for this area.');
  }

  try {
    const res = await fetchWithTimeout(`/api/charging_stations?lat=${lat}&lng=${lng}&radius=${radius}&maxResults=25`);
    const data = await res.json();

    if (data && data.stations && data.stations.length > 0) {
      saveStationCache(lat, lng, radius, data.stations);
      renderNearbyStations(data.stations, `Found ${data.stations.length} stations`);
      updateStationsMap(lat, lng, data.stations);
    } else if (!cached || !Array.isArray(cached.stations)) {
      list.innerHTML = `<div class="empty-state"><p>No stations found in this area.</p></div>`;
    }
  } catch (e) {
    console.warn('Station fetch failed:', e);
    if (cached && Array.isArray(cached.stations)) {
      renderNearbyStations(cached.stations, 'Offline mode: saved station data is shown.');
      updateStationsMap(lat, lng, cached.stations);
    } else {
      showToast('Error loading stations.', 'error');
    }
  }
}

function renderNearbyStations(stations, toastMessage) {
  const list = document.getElementById('nearbyStationsList');
  if (!list) return;

  if (!stations || stations.length === 0) {
    list.innerHTML = `<div class="empty-state"><p>No stations found in this area.</p></div>`;
    return;
  }

  list.innerHTML = stations.map(s => renderStationCard(s, true)).join('');
  if (toastMessage) {
    showToast(toastMessage, toastMessage.includes('saved') || toastMessage.includes('Offline') ? 'error' : 'success');
  }
}

/** Add station markers to the route map (redirected to Stations panel) */
function addStationMarkersToMap(stations) {
  // Remove any markers that were added to the route map earlier
  try {
    if (Array.isArray(state.stationMarkers)) {
      state.stationMarkers.forEach(m => { try { m.setMap && m.setMap(null); m.remove && m.remove(); } catch(e){} });
      state.stationMarkers = [];
    }
  } catch (e) { console.warn('Clearing route markers failed', e); }

  // If we have stations, show only the top (first) station in the Stations panel map
  if (!stations || stations.length === 0) return;
  const top = stations[0];
  if (!top.lat || !top.lng) return;

  // Center stations map on the top station and display only it
  updateStationsMap(top.lat, top.lng, [top]);
}

/** Update the separate stations panel map */
function updateStationsMap(lat, lng, stations) {
  const mapEl = document.getElementById('stationsMapView');

  // Only keep a single station visible (the first/top one)
  const top = (Array.isArray(stations) && stations.length) ? stations[0] : null;

  if (state.mapMode === 'leaflet') {
    // Ensure stations map exists (initMapLeaflet will have created it if present)
    if (!state.leafletStationsMap && mapEl && window.L) {
      state.leafletStationsMap = L.map(mapEl).setView([lat || 20.5937, lng || 78.9629], 10);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors' }).addTo(state.leafletStationsMap);
    }
    if (!state.leafletStationsMap) return;

    state.leafletStationsMap.setView([lat || (top && top.lat) || 20.5937, lng || (top && top.lng) || 78.9629], 12);

    // Clear previous markers
    if (!state.leafletStationsMarkers) state.leafletStationsMarkers = [];
    state.leafletStationsMarkers.forEach(m => m.remove());
    state.leafletStationsMarkers = [];

    if (top && top.lat && top.lng) {
      const color = top.charge_type === 'Fast Charge' ? '#fbbf24' : '#22d3ee';
      const marker = L.circleMarker([top.lat, top.lng], { radius: 11, fillColor: color, fillOpacity: 1, color: '#fff', weight: 3 })
        .bindPopup(`<strong>${top.name}</strong><br>${top.charge_type}<br>${top.max_power_kw || '?'} kW`)
        .addTo(state.leafletStationsMap);
      state.leafletStationsMarkers.push(marker);
      marker.openPopup();
      state.leafletStationsMap.panTo([top.lat, top.lng]);
    }

    // Attach keep-only handlers (still safe if single item)
    setTimeout(() => {
      document.querySelectorAll('.keep-only-btn').forEach((btn, i) => {
        btn.removeEventListener('click', btn._keepHandler);
        const handler = () => keepOnlyStationInStationsMap(i);
        btn._keepHandler = handler;
        btn.addEventListener('click', handler);
      });
    }, 80);
  }

  // Google Maps stations map support
  if (state.mapMode === 'google') {
    // create a dedicated stations map if needed
    if (!state.googleStationsMap && mapEl && window.google) {
      state.googleStationsMap = new google.maps.Map(mapEl, {
        center: { lat: lat || 20.5937, lng: lng || 78.9629 },
        zoom: 10,
        styles: getMapStyles(),
        disableDefaultUI: true,
      });
    }
    if (!state.googleStationsMap) return;

    // Clear old markers
    if (!state.stationsMapMarkers) state.stationsMapMarkers = [];
    state.stationsMapMarkers.forEach(m => m.setMap(null));
    state.stationsMapMarkers = [];

    if (top && top.lat && top.lng) {
      const pos = { lat: top.lat, lng: top.lng };
      const marker = new google.maps.Marker({
        position: pos,
        map: state.googleStationsMap,
        title: top.name,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 10,
          fillColor: top.charge_type === 'Fast Charge' ? '#fbbf24' : '#22d3ee',
          fillOpacity: 1,
          strokeColor: '#fff',
          strokeWeight: 3,
        },
      });
      const iw = new google.maps.InfoWindow({ content: `<strong>${top.name}</strong><br/>${top.charge_type} · ${top.max_power_kw || '?'} kW` });
      marker.addListener('click', () => iw.open(state.googleStationsMap, marker));
      iw.open(state.googleStationsMap, marker);
      state.stationsMapMarkers.push(marker);
      state.googleStationsMap.panTo(pos);
    }
  }
}

/** Render a station card HTML */
function renderStationCard(s, showDistance = false) {
  const isFast = s.charge_type === 'Fast Charge';
  const isOnline = s.is_operational !== false;
  const iconClass = isFast ? 'fast' : 'normal';
  const currentSoc = document.getElementById('currentCharge')?.value || 80;
  const badgeClass = !isOnline ? 'badge-offline' : (isFast ? 'badge-fast' : 'badge-normal');
  const badgeText = !isOnline ? 'Offline' : s.charge_type;

  return `
    <div class="station-card">
      <div class="station-icon ${iconClass}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
      </div>
      <div class="station-info">
        <p class="station-name">${s.name}</p>
        <p class="station-meta">
          ${s.max_power_kw ? s.max_power_kw + ' kW · ' : ''}
          ${s.num_points ? s.num_points + ' points' : ''}
          ${showDistance && s.distance_km ? ' · ' + s.distance_km.toFixed(1) + ' km' : ''}
          · SoC target: ${currentSoc}%
        </p>
        <p class="station-meta" style="margin-top:0.15rem">${s.address || s.city ? `${s.address}${s.city ? ', ' + s.city : ''}` : 'Live charging location'}</p>
      </div>
      <span class="station-badge ${badgeClass}">${badgeText}</span>
      ${showDistance ? `<button class="btn-ghost keep-only-btn" style="margin-left:8px;font-size:0.78rem">Keep Only</button>` : ''}
    </div>
  `;
}

/** Keep only the station at `index` in the stations panel — remove other markers */
function keepOnlyStationInStationsMap(index) {
  if (state.mapMode !== 'leaflet' || !state.leafletStationsMap) {
    showToast('This action is supported only on Leaflet stations map.', 'error');
    return;
  }

  const markers = state.leafletStationsMarkers || [];
  if (!markers.length || index < 0 || index >= markers.length) return;

  markers.forEach((m, i) => {
    if (i === index) {
      // open popup and optionally highlight
      m.openPopup && m.openPopup();
      // apply highlight style
      m.setStyle && m.setStyle({ radius: 11, weight: 3, color: '#f59e0b' });
    } else {
      m.remove();
    }
  });

  // keep only the selected marker in state array
  state.leafletStationsMarkers = [markers[index]];

  // Update the list UI to show only that station card
  const list = document.getElementById('nearbyStationsList');
  if (list) {
    const items = list.querySelectorAll('.station-card');
    items.forEach((it, i) => { if (i !== index) it.remove(); else it.classList.add('best'); });
  }

  showToast('Kept selected station and removed others.', 'success');
}

// ========== Charging-stop marker helpers ==========
/** Haversine distance between two lat/lng points in kilometers */
function haversineDistance(a, b) {
  const R = 6371; // km
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const aa = sinDLat * sinDLat + sinDLon * sinDLon * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return R * c;
}

/** Interpolate between two lat/lng points by fraction t (0-1) */
function interpolateLatLng(a, b, t) {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
  };
}

/** Find lat/lng along the route waypoints at a target distance (km) from start */
function getLatLngAtDistance(waypoints, targetKm) {
  if (!Array.isArray(waypoints) || waypoints.length === 0) return null;
  let acc = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    const seg = haversineDistance(a, b);
    if (acc + seg >= targetKm) {
      const needed = targetKm - acc;
      const t = seg === 0 ? 0 : (needed / seg);
      return interpolateLatLng(a, b, t);
    }
    acc += seg;
  }
  // If target beyond route, return last point
  return waypoints[waypoints.length - 1];
}

/** Add charging stop markers to the visible route map */
function addChargingStopMarkers(recommendations, waypoints) {
  // Clear existing stop markers (separate from stationMarkers)
  if (!state.chargingStopMarkers) state.chargingStopMarkers = [];
  // Remove previous
  if (state.chargingStopMarkers.length) {
    if (state.mapMode === 'google' && state.googleMap) {
      state.chargingStopMarkers.forEach(m => m.setMap(null));
    } else if (state.leafletMap) {
      state.chargingStopMarkers.forEach(m => m.remove());
    }
    state.chargingStopMarkers = [];
  }

  recommendations.forEach(rec => {
    const km = Number(rec.estimated_km_at_stop || rec.km || 0);
    if (!km || km <= 0) return;
    const coord = getLatLngAtDistance(waypoints, km);
    if (!coord) return;

    const label = `Stop ${rec.stop_number}: ${km} km`;
    const isBest = recommendations[0] && rec.stop_number === recommendations[0].stop_number;

    if (state.mapMode === 'google' && state.googleMap) {
      // create special icon for best stop
      const svg = isBest ? `
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24">
              <g>
                <circle cx="12" cy="12" r="11" fill="#f59e0b" stroke="#fff" stroke-width="1"/>
                <circle cx="12" cy="12" r="7" fill="#34d399" stroke="rgba(255,255,255,0.2)" stroke-width="1"/>
                <text x="12" y="16" font-size="9" text-anchor="middle" fill="#062018" font-weight="700">BEST</text>
              </g>
            </svg>` : `
            <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" fill="#34d399" stroke="#fff" stroke-width="1"/>
              <path d="M9 7h6v6l-2 1v3l-2-1v-3l-2-1V7z" fill="#fff"/>
            </svg>`;

      const marker = new google.maps.Marker({
        position: { lat: coord.lat, lng: coord.lng },
        map: state.googleMap,
        title: label,
        icon: {
          url: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg),
          scaledSize: new google.maps.Size(isBest ? 48 : 36, isBest ? 48 : 36),
        },
        animation: isBest && google.maps.Animation.DROP,
      });

      const iw = new google.maps.InfoWindow({ content: `<div style="min-width:160px"><strong>${label}</strong><br/>Charge to ${rec.charge_needed_pct}% ${isBest ? '<br/><strong>Top recommendation</strong>' : ''}</div>` });
      marker.addListener('click', () => iw.open(state.googleMap, marker));
      state.chargingStopMarkers.push(marker);

      // Pan to best marker and open info window
      if (isBest) {
        state.googleMap.panTo({ lat: coord.lat, lng: coord.lng });
        iw.open(state.googleMap, marker);
      }
    } else if (state.leafletMap) {
      const html = `<div class="charging-stop-marker ${isBest ? 'cs-best' : ''}"><div class="cs-circle">⚡</div><div class="cs-label">${label}${isBest ? ' • BEST' : ''}</div></div>`;
      const icon = L.divIcon({ html, className: 'cs-div-icon', iconSize: isBest ? [110, 36] : [80, 30], iconAnchor: [isBest ? 55 : 40, isBest ? 18 : 15] });
      const m = L.marker([coord.lat, coord.lng], { icon }).addTo(state.leafletMap);
      m.bindPopup(`<strong>${label}</strong><br/>Charge to ${rec.charge_needed_pct}%${isBest ? '<br/><strong>Top recommendation</strong>' : ''}`);
      state.chargingStopMarkers.push(m);

      if (isBest) {
        state.leafletMap.panTo([coord.lat, coord.lng]);
        m.openPopup();
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// 7. HISTORY & FAVORITES
// ═══════════════════════════════════════════════════════════════

/** Load route history */
async function loadHistory() {
  const list = document.getElementById('historyList');
  const guestHistory = getGuestHistory();

  try {
    const res = await fetch('/api/get_history', { credentials: 'include' });
    const data = await res.json();
    const serverHistory = data.history || [];
    const combined = [...serverHistory, ...guestHistory].sort((a, b) => new Date(b.created_at || b.saved_at || 0) - new Date(a.created_at || a.saved_at || 0));

    if (combined.length === 0) {
      list.innerHTML = `<div class="empty-state"><p>No routes saved yet. Plan a trip to populate this view.</p></div>`;
      return;
    }

    list.innerHTML = `<div style="display:flex;flex-direction:column;gap:0.5rem">` +
      combined.map(r => `
        <div class="history-card" onclick="fillRoute('${escHtml(r.from_location)}', '${escHtml(r.to_location)}')">
          <p class="history-route">${escHtml(r.from_location)} → ${escHtml(r.to_location)}</p>
          <div class="history-meta">
            ${r.distance_km ? `<span>${r.distance_km.toFixed(0)} km</span>` : ''}
            ${r.duration_min ? `<span>${formatDuration(r.duration_min)}</span>` : ''}
            ${r.charging_stops !== null ? `<span>⚡ ${r.charging_stops} stops</span>` : ''}
            ${r.current_soc ? `<span>SoC ${r.current_soc}%</span>` : ''}
          </div>
          <p class="history-date">${formatDate(r.created_at || r.saved_at)}</p>
          <div style="display:flex;gap:0.4rem;margin-top:0.25rem">
            <button class="btn-ghost" onclick="event.stopPropagation();saveFavorite('${escHtml(r.from_location)}','${escHtml(r.to_location)}')">☆ Favorite</button>
          </div>
        </div>
      `).join('') + `</div>`;
  } catch (e) {
    console.error(e);
    if (guestHistory.length > 0) {
      list.innerHTML = renderGuestHistory(guestHistory);
    } else {
      list.innerHTML = `<div class="empty-state"><p>Unable to load history right now.</p></div>`;
    }
  }
}

/** Load favorites */
async function loadFavorites() {
  if (!state.user) return;

  try {
    const res = await fetch('/api/get_favorites', { credentials: 'include' });
    const data = await res.json();
    const list = document.getElementById('favoritesList');

    if (!data.favorites || data.favorites.length === 0) {
      list.innerHTML = `<div class="empty-state"><p>No favorites yet. Save a route once you start exploring.</p></div>`;
      return;
    }

    list.innerHTML = `<div style="display:flex;flex-direction:column;gap:0.5rem">` +
      data.favorites.map(f => `
        <div class="history-card" onclick="fillRoute('${escHtml(f.from_location)}', '${escHtml(f.to_location)}')">
          <p class="history-route">⭐ ${escHtml(f.name)}</p>
          <p class="station-meta">${escHtml(f.from_location)} → ${escHtml(f.to_location)}</p>
          <button class="btn-danger" style="margin-top:0.4rem;width:fit-content" onclick="event.stopPropagation();deleteFavorite(${f.id})">Remove</button>
        </div>
      `).join('') + `</div>`;
  } catch (e) {
    console.error(e);
  }
}

/** Save a favorite from history panel */
async function saveFavorite(from, to) {
  if (!state.user) {
    showToast('Sign-in features are disabled in this demo view.', 'error');
    return;
  }

  const name = prompt('Name this favorite route:', `${from} → ${to}`) || `${from} → ${to}`;

  try {
    await fetch('/api/save_favorite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, from_location: from, to_location: to }),
    });
    showToast('Saved to favorites! ⭐', 'success');
    loadFavorites();
  } catch (e) {
    showToast('Error saving favorite.', 'error');
  }
}

/** Delete a favorite */
async function deleteFavorite(id) {
  await fetch(`/api/delete_favorite/${id}`, { method: 'DELETE', credentials: 'include' });
  showToast('Favorite removed.', '');
  loadFavorites();
}

/** Save the current route as favorite */
async function saveCurrentRoute() {
  if (!state.user) {
    showToast('Save route is available in the signed-in experience only.', 'error');
    return;
  }
  if (!state.currentRoute) return;

  const { from, to } = state.currentRoute;
  await saveFavorite(from, to);
}

/** Fill the planner form from a saved route */
function fillRoute(from, to) {
  document.getElementById('fromLocation').value = from;
  document.getElementById('toLocation').value = to;
  showPanel('planner');
  showToast('Route loaded. Click "Plan Route" to go!', 'success');
}

function saveGuestHistory(route) {
  const existing = getGuestHistory();
  const entry = {
    ...route,
    saved_at: new Date().toISOString(),
    from_location: route.from_location || 'Current location',
    to_location: route.to_location || 'Destination',
  };
  const next = [entry, ...existing].slice(0, 12);
  localStorage.setItem('ev_guest_history', JSON.stringify(next));
}

function getGuestHistory() {
  try { return JSON.parse(localStorage.getItem('ev_guest_history') || '[]'); } catch { return []; }
}

function renderGuestHistory(entries) {
  return `<div style="display:flex;flex-direction:column;gap:0.5rem">${entries.map(r => `
    <div class="history-card" onclick="fillRoute('${escHtml(r.from_location)}', '${escHtml(r.to_location)}')">
      <p class="history-route">${escHtml(r.from_location)} → ${escHtml(r.to_location)}</p>
      <div class="history-meta">${r.distance_km ? `<span>${r.distance_km.toFixed(0)} km</span>` : ''}${r.duration_min ? `<span>${formatDuration(r.duration_min)}</span>` : ''}${r.charging_stops !== null ? `<span>⚡ ${r.charging_stops} stops</span>` : ''}${r.current_soc ? `<span>SoC ${r.current_soc}%</span>` : ''}</div>
      <p class="history-date">${formatDate(r.saved_at)}</p>
    </div>
  `).join('')}</div>`;
}

function centerStationMap(lat, lng, zoom = 10) {
  const frame = document.querySelector('.station-map-frame iframe');
  if (frame) {
    frame.src = `https://map.openchargemap.io/?mode=embedded&latitude=${lat.toFixed(5)}&longitude=${lng.toFixed(5)}&zoom=${zoom}`;
  }
}

// ═══════════════════════════════════════════════════════════════
// 9. UI UTILITIES
// ═══════════════════════════════════════════════════════════════

/** Swap from/to locations */
function swapLocations() {
  const from = document.getElementById('fromLocation');
  const to = document.getElementById('toLocation');
  [from.value, to.value] = [to.value, from.value];
}

/** Open a modal */
function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('open');
}

/** Close a modal */
function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('open');
}

/** Show toast notification */
function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

/** Toggle between dark/light theme */
function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(state.theme);
  localStorage.setItem('theme', state.theme);
}

/** Apply a theme */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const isDark = theme === 'dark';
  document.getElementById('themeLabel').textContent = isDark ? 'Light Mode' : 'Dark Mode';
  document.getElementById('themeIcon').innerHTML = isDark
    ? `<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>`
    : `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`;
}

/** Format duration in minutes to "Xh Ym" */
function formatDuration(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h === 0) return `${m} min`;
  return `${h}h ${m}m`;
}

/** Format ISO date string */
function formatDate(isoStr) {
  if (!isoStr) return '';
  try {
    return new Date(isoStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return isoStr; }
}

/** Escape HTML to prevent XSS */
function escHtml(str) {
  return (str || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

/** Close modal when clicking overlay */
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('open');
  }
});

/** Close mobile sidebar when clicking outside */
document.addEventListener('click', e => {
  const sidebar = document.getElementById('sidebar');
  const menuBtn = document.querySelector('.mobile-menu-btn');
  if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && !menuBtn.contains(e.target)) {
    sidebar.classList.remove('open');
  }
});

/** Keyboard shortcut: Enter to plan route */
document.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const panel = document.querySelector('.panel.active');
    if (panel && panel.id === 'panel-planner') planRoute();
  }
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
  }
});

// ═══════════════════════════════════════════════════════════════
// 10. ADVANCED ALGORITHMS
// ═══════════════════════════════════════════════════════════════

/** Show/hide algorithm tabs */
function showAlgoTab(tabId) {
  document.querySelectorAll('.algo-tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.algo-tab-btn').forEach(el => el.classList.remove('active'));
  
  const tab = document.getElementById(`algo-${tabId}`);
  const btn = document.querySelector(`.algo-tab-btn[onclick="showAlgoTab('${tabId}')"]`);
  
  if (tab) tab.classList.add('active');
  if (btn) btn.classList.add('active');
}

/** A* Route Planning Algorithm */
async function runAstarAlgorithm() {
  const battery = parseFloat(document.getElementById('astar_battery_kwh').value) || 60;
  const efficiency = parseFloat(document.getElementById('astar_efficiency').value) || 0.2;
  const soc = parseInt(document.getElementById('astar_soc').value) || 80;
  
  const start = { lat: 20.5937, lng: 78.9629 };
  const end = { lat: 28.6139, lng: 77.2090 };
  
  try {
    const response = await fetch('/api/advanced/astar_route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start_lat: start.lat,
        start_lng: start.lng,
        end_lat: end.lat,
        end_lng: end.lng,
        battery_capacity_kwh: battery,
        current_soc_pct: soc,
        efficiency_kwh_per_km: efficiency
      })
    });
    
    const data = await response.json();
    displayAstarResult(data);
  } catch (e) {
    showToast('A* Algorithm error: ' + e.message, 'error');
  }
}

function displayAstarResult(data) {
  const resultDiv = document.getElementById('astar-result');
  const canReach = data.can_reach_direct ? '✅ Yes' : '❌ No';
  const chargingNeeded = data.charging_needed ? '⚡ Yes, charging required' : '✅ No charging needed';
  
  resultDiv.innerHTML = `
    <div class="algo-result-item">
      <span class="algo-result-label">Direct Distance</span>
      <span class="algo-result-value">${data.direct_distance_km.toFixed(1)} km</span>
    </div>
    <div class="algo-result-item">
      <span class="algo-result-label">Current Available Range</span>
      <span class="algo-result-value">${data.available_range_km.toFixed(1)} km @ ${data.current_soc_pct}%</span>
    </div>
    <div class="algo-result-item">
      <span class="algo-result-label">Usable Range (with safety margin)</span>
      <span class="algo-result-value">${data.usable_range_km.toFixed(1)} km</span>
    </div>
    <div class="algo-result-item">
      <span class="algo-result-label">Can Reach Destination Without Stop?</span>
      <span class="algo-result-value" style="color: ${data.can_reach_direct ? '#34d399' : '#f87171'}">${canReach}</span>
    </div>
    <div class="algo-result-item">
      <span class="algo-result-label">Charging Status</span>
      <span class="algo-result-value">${chargingNeeded}</span>
    </div>
    <div class="algo-result-item">
      <span class="algo-result-desc">Algorithm: ${data.algorithm} - Optimizes path using Haversine distance</span>
    </div>
  `;
  resultDiv.classList.add('show');
  showToast('A* Algorithm analysis complete! 🗺️', 'success');
}

/** Battery Range Prediction Algorithm */
async function runBatteryPrediction() {
  const baseRange = parseFloat(document.getElementById('battery_base_range').value) || 400;
  const soc = parseInt(document.getElementById('battery_soc').value) || 80;
  const weather = document.getElementById('battery_weather').value;
  const terrain = document.getElementById('battery_terrain').value;
  const driving = document.getElementById('battery_driving').value;
  const temp = parseInt(document.getElementById('battery_temp').value) || 20;
  
  try {
    const response = await fetch('/api/advanced/battery_prediction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_range_km: baseRange,
        soc_pct: soc,
        weather: weather,
        terrain: terrain,
        driving_style: driving,
        ambient_temp_c: temp
      })
    });
    
    const data = await response.json();
    displayBatteryResult(data);
  } catch (e) {
    showToast('Battery Prediction error: ' + e.message, 'error');
  }
}

function displayBatteryResult(data) {
  const resultDiv = document.getElementById('battery-result');
  
  resultDiv.innerHTML = `
    <div class="algo-result-item">
      <span class="algo-result-label">Base Range</span>
      <span class="algo-result-value">${data.base_range_km.toFixed(0)} km (WLTP)</span>
    </div>
    <div class="algo-result-item">
      <span class="algo-result-label">Current SOC</span>
      <span class="algo-result-value">${data.soc_pct}%</span>
    </div>
    <div class="algo-result-item">
      <span class="algo-result-label">Available Range</span>
      <span class="algo-result-value">${data.available_range_km.toFixed(1)} km</span>
    </div>
    <div class="algo-result-item">
      <span class="algo-result-label" style="color: #fbbf24">⭐ Predicted Real-World Range</span>
      <span class="algo-result-value" style="color: #fbbf24; font-size: 1.3rem">${data.predicted_range_km.toFixed(1)} km</span>
      <span class="algo-result-desc">Based on weather, terrain, driving & temperature</span>
    </div>
    
    <div style="margin-top: 1rem">
      <span class="algo-result-label">Efficiency Factors</span>
      <div class="algo-metrics-grid">
        <div class="metric-box">
          <div class="label">Weather</div>
          <div class="value">${(data.weather_factor * 100).toFixed(0)}%</div>
        </div>
        <div class="metric-box">
          <div class="label">Terrain</div>
          <div class="value">${(data.terrain_factor * 100).toFixed(0)}%</div>
        </div>
        <div class="metric-box">
          <div class="label">Driving</div>
          <div class="value">${(data.driving_factor * 100).toFixed(0)}%</div>
        </div>
        <div class="metric-box">
          <div class="label">Temperature</div>
          <div class="value">${(data.temp_factor * 100).toFixed(0)}%</div>
        </div>
      </div>
    </div>
  `;
  resultDiv.classList.add('show');
  showToast('Battery range predicted! 🔋', 'success');
}

/** Station Selection Algorithm */
async function runStationSelection() {
  const soc = parseInt(document.getElementById('station_soc').value) || 30;
  const distance = parseFloat(document.getElementById('station_distance').value) || 300;
  const range = parseFloat(document.getElementById('station_range').value) || 400;
  const stops = parseInt(document.getElementById('station_stops').value) || 1;
  
  let stations = state.stationMarkers || [];
  
  if (stations.length === 0) {
    showToast('No stations available. Plan a route first.', 'error');
    return;
  }
  
  try {
    const response = await fetch('/api/advanced/station_selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stations: stations.slice(0, 20),
        current_soc_pct: soc,
        total_distance_km: distance,
        battery_range_km: range,
        num_stops_needed: stops
      })
    });
    
    const data = await response.json();
    displayStationResult(data);
  } catch (e) {
    showToast('Station Selection error: ' + e.message, 'error');
  }
}

function displayStationResult(data) {
  const resultDiv = document.getElementById('stations-result');
  const stops = data.optimal_charging_stops || [];
  
  let html = `
    <div class="algo-result-item">
      <span class="algo-result-label">Optimal Charging Stops</span>
      <span class="algo-result-value">${stops.length} selected from ${data.total_stops_analyzed}</span>
      <span class="algo-result-desc">${data.recommendation_algorithm}</span>
    </div>
  `;
  
  stops.forEach((stop, idx) => {
    html += `
      <div class="recommendation-card">
        <div class="title">
          <span>#${stop.rank}: ${stop.name}</span>
          <span class="badge">Score: ${stop.score.toFixed(1)}</span>
        </div>
      </div>
    `;
  });
  
  resultDiv.innerHTML = html;
  resultDiv.classList.add('show');
  showToast(`${stops.length} optimal stations selected! ⚡`, 'success');
}

/** Charging Recommendation Algorithm */
async function runChargingRecommendation() {
  const soc = parseInt(document.getElementById('charging_soc').value) || 30;
  const distance = parseFloat(document.getElementById('charging_distance').value) || 300;
  const battery = parseFloat(document.getElementById('charging_battery').value) || 60;
  const budget = document.getElementById('charging_budget').value;
  
  try {
    const response = await fetch('/api/advanced/charging_recommendation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        current_soc_pct: soc,
        target_distance_km: distance,
        battery_capacity_kwh: battery,
        budget_constraint: budget,
        grid_carbon_intensity: 'medium'
      })
    });
    
    const data = await response.json();
    displayChargingResult(data);
  } catch (e) {
    showToast('Charging Recommendation error: ' + e.message, 'error');
  }
}

function displayChargingResult(data) {
  const resultDiv = document.getElementById('charging-result');
  const strategies = data.strategies || [];
  
  let html = `
    <div class="algo-result-item">
      <span class="algo-result-label">💡 Smart Advice</span>
      <span class="algo-result-desc">${data.smart_advice}</span>
    </div>
  `;
  
  strategies.slice(0, 3).forEach((strategy, idx) => {
    const rankColor = idx === 0 ? '#34d399' : idx === 1 ? '#22d3ee' : '#fbbf24';
    html += `
      <div class="recommendation-card" style="border-left-color: ${rankColor}">
        <div class="title">
          <span style="color: ${rankColor}">#${strategy.rank} ${strategy.name}</span>
        </div>
        <div style="font-size: 0.85rem; color: var(--text-secondary)">
          ${strategy.charge_target_pct}% | ${strategy.charge_time_min} min | $${strategy.estimated_cost.toFixed(2)}
        </div>
      </div>
    `;
  });
  
  resultDiv.innerHTML = html;
  resultDiv.classList.add('show');
  showToast('Charging strategy recommended! 💡', 'success');
}

/** Comprehensive Trip Analysis */
async function runComprehensiveAnalysis() {
  const route = state.currentRoute || null;
  const routePoints = route?.waypoints || [];
  const start = routePoints[0] || { lat: 20.5937, lng: 78.9629 };
  const end = routePoints[routePoints.length - 1] || { lat: 28.6139, lng: 77.2090 };
  const distance = parseFloat(document.getElementById('comp_distance').value) || route?.distanceKm || 300;
  const soc = parseInt(document.getElementById('comp_soc').value) || parseInt(document.getElementById('currentCharge')?.value || 80);
  const weather = document.getElementById('comp_weather')?.value || 'sunny';
  const terrain = document.getElementById('comp_terrain')?.value || 'highway';
  
  try {
    const response = await fetch('/api/advanced/comprehensive_analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start_lat: start.lat,
        start_lng: start.lng,
        end_lat: end.lat,
        end_lng: end.lng,
        total_distance_km: distance,
        current_soc_pct: soc,
        battery_capacity_kwh: parseFloat(document.getElementById('batteryRange')?.value || 60) / 6 || 60,
        battery_range_km: parseFloat(document.getElementById('batteryRange')?.value || 400),
        weather,
        terrain,
        driving_style: 'normal',
        stations: state.stationMarkers || [],
        budget_constraint: 'standard'
      })
    });
    
    const data = await response.json();
    displayComprehensiveResult(data);
  } catch (e) {
    showToast('Comprehensive Analysis error: ' + e.message, 'error');
  }
}

async function runComprehensiveAnalysisFromRoute() {
  const route = state.currentRoute;
  if (!route || !Array.isArray(route.waypoints) || route.waypoints.length < 2) return;

  const start = route.waypoints[0];
  const end = route.waypoints[route.waypoints.length - 1];
  const distance = route.distanceKm || 300;
  const soc = parseInt(document.getElementById('currentCharge')?.value || 80);
  const batteryRange = parseFloat(document.getElementById('batteryRange')?.value || 350);

  try {
    const response = await fetch('/api/advanced/comprehensive_analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start_lat: start.lat,
        start_lng: start.lng,
        end_lat: end.lat,
        end_lng: end.lng,
        total_distance_km: distance,
        current_soc_pct: soc,
        battery_capacity_kwh: Math.max(40, Math.min(150, batteryRange / 6)),
        battery_range_km: batteryRange,
        weather: document.getElementById('comp_weather')?.value || 'sunny',
        terrain: document.getElementById('comp_terrain')?.value || 'highway',
        driving_style: 'normal',
        stations: state.stationMarkers || [],
        budget_constraint: 'standard'
      })
    });

    const data = await response.json();
    displayComprehensiveResult(data);
  } catch (e) {
    console.warn('Automatic comprehensive analysis failed:', e);
  }
}

function displayComprehensiveResult(data) {
  const resultDiv = document.getElementById('comprehensive-result');
  const astar = data.astar_route_planning || {};
  const battery = data.battery_prediction || {};
  const topStrategy = data.top_strategy || (data.charging_recommendations && data.charging_recommendations[0]) || null;
  const tripDistance = data.trip_analysis?.total_distance_km || 0;
  
  let html = `
    <div class="algo-result-item">
      <span class="algo-result-label">📊 Trip Overview</span>
      <span class="algo-result-value">${tripDistance.toFixed(0)} km Journey</span>
    </div>
    <div class="algo-result-item">
      <span class="algo-result-label">🗺️ Route Analysis (A*)</span>
      <span class="algo-result-value">${(astar.direct_distance_km || 0).toFixed(1)} km | Range: ${(astar.available_range_km || 0).toFixed(1)} km</span>
    </div>
    <div class="algo-result-item">
      <span class="algo-result-label">🔋 Battery Prediction</span>
      <span class="algo-result-value" style="color: #fbbf24">${(battery.predicted_range_km || 0).toFixed(1)} km</span>
    </div>
    <div class="algo-result-item">
      <span class="algo-result-label">💡 Best Strategy</span>
      <span class="algo-result-value">${topStrategy ? topStrategy.name : 'Not available'}</span>
    </div>
    <div class="algo-result-item">
      <span class="algo-result-desc">🤖 ${data.smart_advice || 'Analysis complete.'}</span>
    </div>
  `;
  
  resultDiv.innerHTML = html;
  resultDiv.classList.add('show');
  showToast('Complete trip analysis generated! 📊', 'success');
}
