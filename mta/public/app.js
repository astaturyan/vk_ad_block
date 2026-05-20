'use strict';

const LINE_COLOR = {
  '1':'#EE352E','2':'#EE352E','3':'#EE352E',
  '4':'#00933C','5':'#00933C','6':'#00933C','6X':'#00933C',
  '7':'#B933AD','7X':'#B933AD',
  'A':'#0039A6','C':'#0039A6','E':'#0039A6','H':'#0039A6',
  'N':'#FCCC0A','Q':'#FCCC0A','R':'#FCCC0A','W':'#FCCC0A',
  'B':'#FF6319','D':'#FF6319','F':'#FF6319','M':'#FF6319','FX':'#FF6319',
  'G':'#6CBE45','L':'#A7A9AC',
  'J':'#996633','Z':'#996633',
  'S':'#808183','SIR':'#0078C6',
};
const DARK_TEXT = new Set(['N','Q','R','W','G','L','S','7X']);

const DEST = {
  N: {
    '1':'242 St','2':'Wakefield-241 St','3':'Harlem-148 St',
    '4':'Woodlawn','5':'Eastchester-Dyre Av','6':'Pelham Bay Park','6X':'Pelham Bay Park',
    '7':'Flushing-Main St','7X':'Flushing-Main St',
    'A':'Inwood-207 St / Wash Hts','C':'168 St','E':'Jamaica Center',
    'B':'Bedford Park Blvd','D':'Norwood-205 St','F':'Jamaica-179 St','M':'Forest Hills-71 Av',
    'N':'Astoria-Ditmars','Q':'96 St','R':'Forest Hills-71 Av','W':'Astoria-Ditmars',
    'G':'Court Sq','L':'8 Av','J':'Jamaica Center','Z':'Jamaica Center',
  },
  S: {
    '1':'South Ferry','2':'Flatbush Av-Brooklyn College','3':'New Lots Av',
    '4':'New Lots Av / Crown Hts','5':'Flatbush Av-Brooklyn College','6':'Brooklyn Bridge','6X':'Brooklyn Bridge',
    '7':'Hudson Yards','7X':'Hudson Yards',
    'A':'Far Rockaway / Lefferts Blvd','C':'Euclid Av','E':'World Trade Center',
    'B':'Brighton Beach','D':'Coney Island-Stillwell','F':'Coney Island-Stillwell','M':'Middle Village-Metropolitan',
    'N':'Coney Island-Stillwell','Q':'Coney Island-Stillwell','R':'Bay Ridge-95 St','W':'Whitehall St',
    'G':'Church Av','L':'Canarsie-Rockaway Pkwy','J':'Broad St','Z':'Broad St',
  }
};

let catalog        = null;        // full catalog from /api/catalog
let userConfig     = null;        // { stations: [...] }
let stations       = [];          // hydrated stations in user order
let allArrivals    = null;
let allAlerts      = null;
let currentStation = null;
let currentDir     = 'N';
let alertsOpen     = false;
let countdown      = 30;
let refreshTimer, tickTimer;

let modalTracked   = [];          // working copy while modal open
let modalSearch    = '';

// ────────────────────────────────────────────
//  Boot
// ────────────────────────────────────────────

async function boot() {
  try {
    const [cat, cfg] = await Promise.all([
      fetch('api/catalog').then(r => r.json()),
      fetch('api/config').then(r => r.json()),
    ]);
    if (cat.ok) catalog    = cat.catalog;
    if (cfg.ok) { userConfig = cfg.config; stations = cfg.stations; }
    if (!stations.length) { showError('No stations configured'); return; }
    currentStation = stations[0].id;
    renderStationTabs();
    fetchData();
  } catch (e) {
    showError('Boot failed: ' + e.message);
  }
}

async function fetchData() {
  try {
    const [r1, r2] = await Promise.all([
      fetch('api/arrivals').then(r => r.json()),
      fetch('api/alerts').then(r => r.json()),
    ]);
    if (r1.ok) { allArrivals = r1.data; setUpdated(r1.ts); }
    if (r2.ok) { allAlerts = r2.alerts; renderAlerts(); }
    renderArrivals();
  } catch {
    showError('Connection error — retrying…');
  }
  scheduleRefresh();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  clearInterval(tickTimer);
  countdown = 30;
  tick();
  tickTimer    = setInterval(tick, 1000);
  refreshTimer = setTimeout(() => { clearInterval(tickTimer); fetchData(); }, 30000);
}

function tick() {
  const el = document.getElementById('countdown');
  if (el) el.textContent = `↻ ${countdown--}s`;
}

function setUpdated(ts) {
  const el = document.getElementById('last-updated');
  if (el) el.textContent = `Updated ${new Date(ts).toLocaleTimeString()}`;
}

// ────────────────────────────────────────────
//  Station tabs
// ────────────────────────────────────────────

function renderStationTabs() {
  const tabs = document.getElementById('station-tabs');
  tabs.innerHTML = stations.map(s => `
    <button class="tab ${s.id === currentStation ? 'active' : ''}"
            data-station="${s.id}"
            onclick="selectStation('${s.id}')">
      ${escapeHtml(s.name)}
    </button>
  `).join('');
}

function selectStation(id) {
  currentStation = id;
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.station === id)
  );
  renderArrivals();
}

function setDirection(dir) {
  currentDir = dir;
  document.getElementById('dir-N').classList.toggle('active', dir === 'N');
  document.getElementById('dir-S').classList.toggle('active', dir === 'S');
  renderArrivals();
}

// ────────────────────────────────────────────
//  Arrivals
// ────────────────────────────────────────────

function renderArrivals() {
  const container = document.getElementById('arrivals');
  const infoEl    = document.getElementById('station-info');

  if (!allArrivals) { container.innerHTML = '<div class="state-msg">Loading…</div>'; return; }

  const station = allArrivals[currentStation];
  if (!station) {
    container.innerHTML = '<div class="state-msg">Station not loaded</div>';
    return;
  }

  // Hydrate direction labels from station data
  document.getElementById('dir-N-label').textContent = shortDir(station.north);
  document.getElementById('dir-S-label').textContent = shortDir(station.south);

  infoEl.innerHTML =
    `<div class="station-name">${escapeHtml(station.name)}</div>` +
    `<div class="station-sub">${routesHTML(station.routes)} · ${escapeHtml(station.borough)}</div>`;

  const trains = station[currentDir] || [];
  const dirLabel = currentDir === 'N' ? station.north : station.south;

  if (trains.length === 0) {
    container.innerHTML =
      `<div class="dir-label">${escapeHtml(dirLabel)}</div>` +
      `<div class="state-msg">No trains in the next 90 min</div>` +
      relevantAlertsHTML(currentStation);
    return;
  }

  container.innerHTML =
    `<div class="dir-label">${escapeHtml(dirLabel)}</div>` +
    `<div class="trains">${trains.map(t => trainHTML(t, currentDir)).join('')}</div>` +
    relevantAlertsHTML(currentStation);
}

function shortDir(label) {
  if (!label) return '';
  // Pick the first half before " - " or " & " for compactness
  return label.split(/ [-&] /)[0];
}

function trainHTML(t, dir) {
  const color = LINE_COLOR[t.route] || '#808183';
  const dark  = DARK_TEXT.has(t.route);
  const txt   = dark ? '#000' : '#fff';
  const dest  = DEST[dir]?.[t.route] || '';
  const minTxt = t.minutes === 0 ? 'Now' : `${t.minutes} min`;
  const cls   = t.minutes <= 1 ? 'urgent' : t.minutes <= 4 ? 'soon' : '';
  const tag   = trainTag(t);

  return `
    <div class="train ${cls}">
      <div class="bullet" style="background:${color};color:${txt}">${escapeHtml(t.route)}</div>
      <div class="train-dest">
        <div>${escapeHtml(dest)}</div>
        ${tag ? `<div class="train-id" title="${escapeHtml(t.tripId || '')}">${tag}</div>` : ''}
      </div>
      <div class="train-min">${minTxt}</div>
    </div>`;
}

// "106200_R..N93R" → { run: "93R", startTime } → "#93R · 5:42 PM"
function trainTag(t) {
  let run = '';
  if (t.tripId) {
    // run number lives after direction letter: e.g. _R..N93R or _R..S71
    const m = t.tripId.match(/_[^.]+\.\.[NS](\d+[A-Z]?)/);
    if (m) run = m[1];
  }
  const time = formatStartTime(t.startTime);
  if (run && time) return `#${run} · started ${time}`;
  if (time)        return `Started ${time}`;
  if (run)         return `#${run}`;
  return '';
}

function formatStartTime(s) {
  if (!s) return '';
  const [hStr, mStr] = s.split(':');
  const h = parseInt(hStr, 10);
  if (isNaN(h)) return '';
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h % 12 || 12;
  return `${h12}:${mStr} ${ampm}`;
}

function routesHTML(routes) {
  return routes.map(r => {
    const color = LINE_COLOR[r] || '#808183';
    const dark  = DARK_TEXT.has(r);
    return `<span class="bullet sm" style="background:${color};color:${dark?'#000':'#fff'}">${escapeHtml(r)}</span>`;
  }).join('');
}

// ────────────────────────────────────────────
//  Alerts (global banner + per-station inline)
// ────────────────────────────────────────────

function renderAlerts() {
  const section = document.getElementById('alerts-section');
  const list    = document.getElementById('alerts-list');
  const label   = document.getElementById('alerts-label');

  if (!allAlerts || allAlerts.length === 0) { section.classList.add('hidden'); return; }

  section.classList.remove('hidden');
  label.textContent = `⚠️ ${allAlerts.length} Service Alert${allAlerts.length !== 1 ? 's' : ''}`;
  list.innerHTML = allAlerts.slice(0, 30).map(a => alertItemHTML(a)).join('');
}

function alertItemHTML(a) {
  const when = formatAlertPeriod(a.activePeriods);
  return `
    <div class="alert-item">
      <div class="alert-bullets">${a.lines.map(l => bulletHTML(l)).join('')}</div>
      <div>
        <div class="alert-header">${escapeHtml(a.header)}</div>
        ${when ? `<div class="alert-when">${escapeHtml(when)}</div>` : ''}
        ${a.desc ? `<div class="alert-desc">${escapeHtml(a.desc.slice(0, 240))}${a.desc.length > 240 ? '…' : ''}</div>` : ''}
      </div>
    </div>`;
}

function formatAlertPeriod(periods) {
  if (!periods || periods.length === 0) return '';
  const now = Math.floor(Date.now() / 1000);
  // Find the period that is currently active (or the next upcoming one)
  let p = periods.find(x => (!x.start || now >= x.start) && (!x.end || now <= x.end));
  if (!p) p = periods.find(x => x.start && x.start > now);
  if (!p) p = periods[0];
  if (!p) return '';

  const isUpcoming = p.start && p.start > now;

  if (p.start && p.end) {
    return isUpcoming
      ? `From ${formatTs(p.start)} – ${formatTs(p.end)}`
      : `Until ${formatTs(p.end)}`;
  }
  if (p.end) return `Until ${formatTs(p.end)}`;
  if (p.start) {
    return isUpcoming
      ? `Starts ${formatTs(p.start)}`
      : `Since ${formatTs(p.start)}`;
  }
  return '';
}

function formatTs(sec) {
  const d  = new Date(sec * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();

  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();

  const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  if (sameDay)    return timeStr;
  if (isTomorrow) return `tomorrow ${timeStr}`;

  // Within the next 7 days → weekday name
  const diffDays = Math.round((d - now) / 86400000);
  if (diffDays > 0 && diffDays < 7) {
    return `${d.toLocaleDateString([], { weekday: 'short' })} ${timeStr}`;
  }
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function bulletHTML(line) {
  const color = LINE_COLOR[line] || '#808183';
  const dark  = DARK_TEXT.has(line);
  return `<div class="bullet sm" style="background:${color};color:${dark?'#000':'#fff'}">${escapeHtml(line)}</div>`;
}

function relevantAlertsHTML(stationId) {
  if (!allAlerts || !stationId) return '';
  const relevant = allAlerts.filter(a => a.stationIds.includes(stationId));
  if (relevant.length === 0) return '';

  return `
    <div class="inline-alerts">
      <div class="inline-alerts-title">⚠️ Alerts for this station</div>
      ${relevant.slice(0, 3).map(a => alertItemHTML(a)).join('')}
    </div>`;
}

function toggleAlerts() {
  alertsOpen = !alertsOpen;
  document.getElementById('alerts-list').classList.toggle('open', alertsOpen);
  document.getElementById('alerts-chevron').textContent = alertsOpen ? '▴' : '▾';
}

function showError(msg) {
  document.getElementById('arrivals').innerHTML = `<div class="state-msg error">${escapeHtml(msg)}</div>`;
}

// ────────────────────────────────────────────
//  Settings modal
// ────────────────────────────────────────────

function openSettings() {
  if (!catalog) return;
  modalTracked = [...userConfig.stations];
  modalSearch = '';
  document.getElementById('catalog-search').value = '';
  document.getElementById('settings-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderTrackedList();
  renderCatalog();
}

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
  document.body.style.overflow = '';
}

function renderTrackedList() {
  const el = document.getElementById('tracked-list');
  const empty = document.getElementById('tracked-empty');
  const byId = new Map(catalog.stations.map(s => [s.id, s]));

  if (modalTracked.length === 0) {
    el.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  el.innerHTML = modalTracked.map((id, i) => {
    const s = byId.get(id);
    if (!s) return '';
    return `
      <div class="tracked-item">
        <div class="tracked-info">
          <div class="tracked-name">${escapeHtml(s.name)}</div>
          <div class="tracked-meta">${routesHTML(s.routes)} · ${escapeHtml(s.borough)}</div>
        </div>
        <div class="tracked-actions">
          <button onclick="moveTracked(${i}, -1)" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button onclick="moveTracked(${i}, +1)" ${i === modalTracked.length - 1 ? 'disabled' : ''}>↓</button>
          <button onclick="removeTracked(${i})" class="danger">✕</button>
        </div>
      </div>`;
  }).join('');
}

function moveTracked(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= modalTracked.length) return;
  [modalTracked[i], modalTracked[j]] = [modalTracked[j], modalTracked[i]];
  renderTrackedList();
}

function removeTracked(i) {
  modalTracked.splice(i, 1);
  renderTrackedList();
  renderCatalog();   // tracked badge shows in catalog list
}

function addTracked(id) {
  if (modalTracked.includes(id)) return;
  modalTracked.push(id);
  renderTrackedList();
  renderCatalog();
}

function renderCatalog() {
  const list  = document.getElementById('catalog-list');
  const count = document.getElementById('catalog-count');
  const q = (document.getElementById('catalog-search').value || '').trim().toLowerCase();

  let filtered = catalog.stations;
  if (q) {
    filtered = filtered.filter(s => {
      const nameMatch = s.name.toLowerCase().includes(q);
      const boroughMatch = s.borough.toLowerCase().includes(q);
      const routeMatch = s.routes.some(r => r.toLowerCase() === q);
      return nameMatch || boroughMatch || routeMatch;
    });
  }
  filtered = filtered.slice(0, 80);  // perf cap

  count.textContent = q
    ? `${filtered.length} result${filtered.length !== 1 ? 's' : ''} (showing first 80)`
    : `${catalog.stations.length} total — type to search`;

  const tracked = new Set(modalTracked);

  list.innerHTML = filtered.map(s => {
    const isTracked = tracked.has(s.id);
    return `
      <div class="catalog-item ${isTracked ? 'is-tracked' : ''}" onclick="addTracked('${s.id}')">
        <div class="catalog-info">
          <div class="catalog-name">${escapeHtml(s.name)}</div>
          <div class="catalog-meta">${routesHTML(s.routes)} · ${escapeHtml(s.borough)}</div>
        </div>
        <div class="catalog-status">${isTracked ? '✓ Added' : '+ Add'}</div>
      </div>`;
  }).join('');
}

async function saveSettings() {
  if (modalTracked.length === 0) {
    alert('Pick at least one station');
    return;
  }
  try {
    const res = await fetch('api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stations: modalTracked }),
    }).then(r => r.json());

    if (!res.ok) { alert('Save failed: ' + (res.error || 'unknown')); return; }

    closeSettings();
    // Refresh everything
    userConfig = res.config;
    const cfg = await fetch('api/config').then(r => r.json());
    stations = cfg.stations;
    if (!stations.find(s => s.id === currentStation)) currentStation = stations[0].id;
    renderStationTabs();
    fetchData();
  } catch (e) {
    alert('Save failed: ' + e.message);
  }
}

// ────────────────────────────────────────────
//  Utils
// ────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

window.addEventListener('DOMContentLoaded', boot);
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSettings();
});
