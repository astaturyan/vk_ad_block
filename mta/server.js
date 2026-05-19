'use strict';

const express = require('express');
const fetch = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

const DATA_DIR     = path.join(__dirname, 'data');
const CATALOG_PATH = path.join(DATA_DIR, 'catalog.json');
const CONFIG_PATH  = path.join(DATA_DIR, 'user-config.json');

const FEED_URLS = {
  '123456S': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
  'ace':     'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
  'bdfm':    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
  'g':       'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g',
  'jz':      'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz',
  'l':       'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l',
  'nqrw':    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',
  '7':       'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-7',
  'si':      'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si',
  'alerts':  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fall-alerts',
};

// Defaults match the user's original four stations.
const DEFAULT_STATIONS = ['c37', 'c602', 'c613', 'c26'];

const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
const stationsById = new Map();
for (const s of catalog.stations) stationsById.set(s.id, s);

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (raw && Array.isArray(raw.stations)) {
      const valid = raw.stations.filter(id => stationsById.has(id));
      if (valid.length) return { stations: valid };
    }
  } catch { /* fall through to default */ }
  return { stations: DEFAULT_STATIONS.filter(id => stationsById.has(id)) };
}

function saveConfig(config) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const feedCache = {};
const CACHE_TTL = 30 * 1000;

function toSeconds(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  if (val.toNumber) return val.toNumber();
  if (typeof val.low === 'number') return val.low;
  return 0;
}

async function fetchFeed(feedKey) {
  const url = FEED_URLS[feedKey];
  if (!url) throw new Error(`Unknown feed: ${feedKey}`);

  const now = Date.now();
  const cached = feedCache[feedKey];
  if (cached && now - cached.ts < CACHE_TTL) return cached.data;

  const res = await fetch(url, { headers: { 'Accept': 'application/x-protobuf' } });
  if (!res.ok) throw new Error(`Feed ${feedKey}: HTTP ${res.status}`);

  const buf = await res.arrayBuffer();
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buf));
  feedCache[feedKey] = { data: feed, ts: now };
  return feed;
}

function extractArrivals(feed, targetStops) {
  const nowSec = Math.floor(Date.now() / 1000);
  const out = [];

  for (const entity of feed.entity) {
    if (!entity.tripUpdate) continue;
    const tu = entity.tripUpdate;
    const route = tu.trip?.routeId || '?';

    for (const stu of tu.stopTimeUpdate) {
      if (!targetStops.has(stu.stopId)) continue;
      const t = toSeconds(stu.arrival?.time) || toSeconds(stu.departure?.time);
      if (!t) continue;
      const minutes = Math.round((t - nowSec) / 60);
      if (minutes < 0 || minutes > 90) continue;
      out.push({ stopId: stu.stopId, route, minutes });
    }
  }

  return out;
}

// ────────────────────────────────────────────
//  API
// ────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/catalog', (req, res) => {
  res.json({ ok: true, catalog });
});

app.get('/api/config', (req, res) => {
  const config = loadConfig();
  const stations = config.stations.map(id => stationsById.get(id)).filter(Boolean);
  res.json({ ok: true, config, stations });
});

app.put('/api/config', (req, res) => {
  const ids = req.body?.stations;
  if (!Array.isArray(ids)) {
    return res.status(400).json({ ok: false, error: 'stations array required' });
  }
  const valid = [...new Set(ids.filter(id => stationsById.has(id)))];
  if (valid.length === 0) {
    return res.status(400).json({ ok: false, error: 'no valid station ids' });
  }
  const config = { stations: valid };
  saveConfig(config);
  res.json({ ok: true, config });
});

app.get('/api/arrivals', async (req, res) => {
  try {
    const config = loadConfig();
    const stations = config.stations.map(id => stationsById.get(id)).filter(Boolean);

    const feedsNeeded = new Set();
    for (const s of stations) s.feeds.forEach(f => feedsNeeded.add(f));

    const feedData = {};
    await Promise.all([...feedsNeeded].map(async f => {
      try { feedData[f] = await fetchFeed(f); }
      catch (e) { console.error(`Feed ${f} failed:`, e.message); feedData[f] = null; }
    }));

    const result = {};
    for (const s of stations) {
      const directions = { N: [], S: [] };
      for (const dir of ['N', 'S']) {
        const stops = new Set(s.stopIds.map(id => id + dir));
        const all = [];
        for (const fkey of s.feeds) {
          if (feedData[fkey]) all.push(...extractArrivals(feedData[fkey], stops));
        }
        all.sort((a, b) => a.minutes - b.minutes);
        directions[dir] = all.slice(0, 10);
      }
      result[s.id] = {
        id: s.id,
        name: s.name,
        borough: s.borough,
        routes: s.routes,
        north: s.north,
        south: s.south,
        ...directions,
      };
    }

    res.json({ ok: true, data: result, ts: Date.now() });
  } catch (err) {
    console.error('Arrivals error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/alerts', async (req, res) => {
  try {
    const config = loadConfig();
    const stations = config.stations.map(id => stationsById.get(id)).filter(Boolean);

    const routeToStations = new Map();
    const stopToStations  = new Map();
    for (const s of stations) {
      for (const r of s.routes) {
        if (!routeToStations.has(r)) routeToStations.set(r, []);
        routeToStations.get(r).push(s.id);
      }
      for (const stop of s.stopIds) {
        if (!stopToStations.has(stop)) stopToStations.set(stop, []);
        stopToStations.get(stop).push(s.id);
      }
    }

    const feed = await fetchFeed('alerts');
    const alerts = [];

    for (const entity of feed.entity) {
      if (!entity.alert) continue;
      const a = entity.alert;

      const affectedStations = new Set();
      const lines = new Set();

      for (const ie of a.informedEntity || []) {
        if (ie.routeId && routeToStations.has(ie.routeId)) {
          routeToStations.get(ie.routeId).forEach(id => affectedStations.add(id));
          lines.add(ie.routeId);
        }
        const cleanStop = ie.stopId ? ie.stopId.replace(/[NS]$/, '') : null;
        if (cleanStop && stopToStations.has(cleanStop)) {
          stopToStations.get(cleanStop).forEach(id => affectedStations.add(id));
        }
      }

      if (affectedStations.size === 0) continue;

      const header = a.headerText?.translation?.[0]?.text || '';
      const desc   = a.descriptionText?.translation?.[0]?.text || '';
      if (!header) continue;

      alerts.push({
        header,
        desc,
        lines: [...lines],
        stationIds: [...affectedStations],
      });
    }

    res.json({ ok: true, alerts, ts: Date.now() });
  } catch (err) {
    console.error('Alerts error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`MTA Tracker → http://127.0.0.1:${PORT} (catalog: ${catalog.stations.length} stations)`);
});
