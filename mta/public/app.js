'use strict';

const LINE_COLOR = {
  '1':'#EE352E','2':'#EE352E','3':'#EE352E',
  '4':'#00933C','5':'#00933C','6':'#00933C',
  'A':'#0039A6','C':'#0039A6','E':'#0039A6',
  'N':'#FCCC0A','Q':'#FCCC0A','R':'#FCCC0A','W':'#FCCC0A',
  'B':'#FF6319','D':'#FF6319','F':'#FF6319','M':'#FF6319',
  'G':'#6CBE45','L':'#A7A9AC','J':'#996633','Z':'#996633',
  '7':'#B933AD','S':'#808183',
};
const DARK_TEXT = new Set(['N','Q','R','W','G','L','S']);

const DEST = {
  N: {
    '4':'Woodlawn','5':'Eastchester–Dyre Av','6':'Pelham Bay Park',
    'N':'Astoria–Ditmars Blvd','Q':'96 St','R':'Forest Hills–71 Av',
    'W':'Astoria–Ditmars Blvd','B':'Bedford Park Blvd','D':'Norwood–205 St',
  },
  S: {
    '4':'New Lots Av','5':'Flatbush Av–Brooklyn College','6':'Brooklyn Bridge–City Hall',
    'N':'Coney Island–Stillwell Av','Q':'Coney Island–Stillwell Av',
    'R':'Bay Ridge–95 St','W':'Whitehall St–South Ferry',
    'B':'Brighton Beach','D':'Coney Island–Stillwell Av',
  }
};

let currentStation = '77st';
let currentDir     = 'N';
let allData        = null;
let allAlerts      = null;
let alertsOpen     = false;
let countdown      = 30;
let refreshTimer, tickTimer;

async function fetchAll() {
  try {
    const [r1, r2] = await Promise.all([
      fetch('api/arrivals').then(r => r.json()),
      fetch('api/alerts').then(r => r.json()),
    ]);
    if (r1.ok) { allData = r1.data; setUpdated(r1.ts); }
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
  tickTimer   = setInterval(tick, 1000);
  refreshTimer = setTimeout(() => { clearInterval(tickTimer); fetchAll(); }, 30000);
}

function tick() {
  const el = document.getElementById('countdown');
  if (el) el.textContent = `↻ ${countdown--}s`;
}

function setUpdated(ts) {
  const el = document.getElementById('last-updated');
  if (el) el.textContent = `Updated ${new Date(ts).toLocaleTimeString()}`;
}

/* ── Station / direction ── */
function selectStation(key) {
  currentStation = key;
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.station === key)
  );
  renderArrivals();
}

function setDirection(dir) {
  currentDir = dir;
  document.getElementById('dir-N').classList.toggle('active', dir === 'N');
  document.getElementById('dir-S').classList.toggle('active', dir === 'S');
  renderArrivals();
}

/* ── Render arrivals ── */
function renderArrivals() {
  const container = document.getElementById('arrivals');
  const infoEl    = document.getElementById('station-info');

  if (!allData) { container.innerHTML = '<div class="state-msg">Loading…</div>'; return; }

  const station = allData[currentStation];
  if (!station) return;

  infoEl.innerHTML =
    `<div class="station-name">${station.name}</div>` +
    `<div class="station-sub">${station.subtitle}</div>`;

  const trains = station[currentDir] || [];

  if (trains.length === 0) {
    container.innerHTML = '<div class="state-msg">No trains in the next 90 min</div>';
    return;
  }

  const label = currentDir === 'N' ? 'Uptown / Manhattan' : 'Downtown / Brooklyn';
  const dir   = currentDir;

  container.innerHTML =
    `<div class="dir-label">${label}</div>` +
    `<div class="trains">${trains.map(t => trainHTML(t, dir)).join('')}</div>`;
}

function trainHTML(t, dir) {
  const color   = LINE_COLOR[t.route] || '#808183';
  const dark    = DARK_TEXT.has(t.route);
  const textCol = dark ? '#000' : '#fff';
  const dest    = DEST[dir]?.[t.route] || (dir === 'N' ? 'Uptown' : 'Downtown');
  const minTxt  = t.minutes === 0 ? 'Now' : `${t.minutes} min`;
  const cls     = t.minutes <= 1 ? 'urgent' : t.minutes <= 4 ? 'soon' : '';

  return `
    <div class="train ${cls}">
      <div class="bullet" style="background:${color};color:${textCol}">${t.route}</div>
      <div class="train-dest">${dest}</div>
      <div class="train-min">${minTxt}</div>
    </div>`;
}

/* ── Alerts ── */
function renderAlerts() {
  const section = document.getElementById('alerts-section');
  const list    = document.getElementById('alerts-list');
  const label   = document.getElementById('alerts-label');

  if (!allAlerts || allAlerts.length === 0) { section.classList.add('hidden'); return; }

  section.classList.remove('hidden');
  label.textContent = `⚠️ ${allAlerts.length} Service Alert${allAlerts.length !== 1 ? 's' : ''}`;

  list.innerHTML = allAlerts.map(a => `
    <div class="alert-item">
      <div class="alert-bullets">
        ${a.lines.map(l => bulletHTML(l)).join('')}
      </div>
      <div>
        <div class="alert-header">${a.header}</div>
        ${a.desc ? `<div class="alert-desc">${a.desc.slice(0, 220)}${a.desc.length > 220 ? '…' : ''}</div>` : ''}
      </div>
    </div>`).join('');
}

function bulletHTML(line) {
  const color = LINE_COLOR[line] || '#808183';
  const dark  = DARK_TEXT.has(line);
  return `<div class="bullet sm" style="background:${color};color:${dark?'#000':'#fff'}">${line}</div>`;
}

function toggleAlerts() {
  alertsOpen = !alertsOpen;
  document.getElementById('alerts-list').classList.toggle('open', alertsOpen);
  document.getElementById('alerts-chevron').textContent = alertsOpen ? '▴' : '▾';
}

function showError(msg) {
  document.getElementById('arrivals').innerHTML =
    `<div class="state-msg error">${msg}</div>`;
}

window.addEventListener('DOMContentLoaded', fetchAll);
