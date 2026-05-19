#!/usr/bin/env node
// Generates data/catalog.json from data/stations-raw.csv (MTA's Stations.csv).
// Groups subway stops by Complex ID so a "station" = a transfer complex.

'use strict';

const fs   = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, '..', 'data', 'stations-raw.csv');
const OUT_PATH = path.join(__dirname, '..', 'data', 'catalog.json');

// stop_id letter prefix → GTFS-RT feed key
const PREFIX_FEED = {
  '1': '123456S', '2': '123456S', '3': '123456S',
  '4': '123456S', '5': '123456S', '6': '123456S',
  'A': 'ace', 'C': 'ace', 'E': 'ace', 'H': 'ace',
  'B': 'bdfm', 'D': 'bdfm', 'F': 'bdfm', 'M': 'bdfm',
  'G': 'g',
  'J': 'jz', 'Z': 'jz',
  'L': 'l',
  'N': 'nqrw', 'Q': 'nqrw', 'R': 'nqrw', 'W': 'nqrw',
  'S': '123456S',
  '7': '7',
};

const BOROUGH_NAME = {
  'M':  'Manhattan',
  'Bk': 'Brooklyn',
  'Q':  'Queens',
  'Bx': 'Bronx',
  'SI': 'Staten Island',
};

function feedForStop(stopId) {
  return PREFIX_FEED[stopId[0]] || null;
}

function parseCsvLine(line) {
  // Handle quoted commas (rare in this CSV but be safe)
  const out = [];
  let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === ',' && !inQ) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

const rows = fs.readFileSync(CSV_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
const header = parseCsvLine(rows.shift());

const idx = name => header.indexOf(name);
const I = {
  stationId:  idx('Station ID'),
  complexId:  idx('Complex ID'),
  gtfsStopId: idx('GTFS Stop ID'),
  line:       idx('Line'),
  stopName:   idx('Stop Name'),
  borough:    idx('Borough'),
  routes:     idx('Daytime Routes'),
  northLabel: idx('North Direction Label'),
  southLabel: idx('South Direction Label'),
};

const complexes = new Map();

for (const line of rows) {
  const f = parseCsvLine(line);
  if (f.length < header.length) continue;

  const complexId = f[I.complexId];
  const stopId    = f[I.gtfsStopId];
  const name      = f[I.stopName];
  const borough   = f[I.borough];
  const routes    = f[I.routes].split(/\s+/).filter(Boolean);
  const northLbl  = f[I.northLabel];
  const southLbl  = f[I.southLabel];

  if (!complexes.has(complexId)) {
    complexes.set(complexId, {
      id: 'c' + complexId,
      names: new Map(),
      borough,
      routes: new Set(),
      stopIds: new Set(),
      feeds: new Set(),
      northLabels: new Map(),
      southLabels: new Map(),
    });
  }

  const c = complexes.get(complexId);
  c.names.set(name, (c.names.get(name) || 0) + 1);
  routes.forEach(r => c.routes.add(r));
  c.stopIds.add(stopId);

  const feed = feedForStop(stopId);
  if (feed) c.feeds.add(feed);

  if (northLbl) c.northLabels.set(northLbl, (c.northLabels.get(northLbl) || 0) + 1);
  if (southLbl) c.southLabels.set(southLbl, (c.southLabels.get(southLbl) || 0) + 1);
}

function mostCommon(map) {
  let best = '', bestN = 0;
  for (const [k, n] of map) if (n > bestN) { best = k; bestN = n; }
  return best;
}

// Stable route ordering
const ROUTE_ORDER = ['1','2','3','4','5','6','7','A','C','E','B','D','F','M','G','J','Z','L','N','Q','R','W','S','SIR'];
function sortRoutes(arr) {
  return [...arr].sort((a, b) => {
    const ai = ROUTE_ORDER.indexOf(a), bi = ROUTE_ORDER.indexOf(b);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  });
}

const stations = [];
for (const c of complexes.values()) {
  const name = mostCommon(c.names);
  const routes = sortRoutes(c.routes);
  stations.push({
    id: c.id,
    name,
    borough: BOROUGH_NAME[c.borough] || c.borough,
    routes,
    feeds: [...c.feeds].sort(),
    stopIds: [...c.stopIds].sort(),
    north: mostCommon(c.northLabels) || 'Uptown',
    south: mostCommon(c.southLabels) || 'Downtown',
  });
}

// Sort: borough → name
const BOROUGH_ORDER = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'];
stations.sort((a, b) => {
  const bi = BOROUGH_ORDER.indexOf(a.borough) - BOROUGH_ORDER.indexOf(b.borough);
  if (bi !== 0) return bi;
  return a.name.localeCompare(b.name);
});

const catalog = {
  generatedAt: new Date().toISOString(),
  stationCount: stations.length,
  stations,
};

fs.writeFileSync(OUT_PATH, JSON.stringify(catalog, null, 2));
console.log(`✓ Wrote ${OUT_PATH} (${stations.length} complexes, ${stations.reduce((s,x)=>s+x.stopIds.length,0)} stops)`);
