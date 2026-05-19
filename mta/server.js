'use strict';

const express = require('express');
const fetch = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

const STATIONS = {
  '77st': {
    name: '77 St',
    subtitle: 'R train · Bay Ridge Br',
    feeds: ['nqrw'],
    stops: { N: ['R35N'], S: ['R35S'] }
  },
  'unionsq': {
    name: '14 St – Union Sq',
    subtitle: '4 · 5 · 6 · N · R · W',
    feeds: ['456', 'nqrw'],
    stops: { N: ['635N', 'R20N'], S: ['635S', 'R20S'] }
  },
  '59lex': {
    name: '59 St – Lex Ave',
    subtitle: '4 · 5 · 6 · N · R · W',
    feeds: ['456', 'nqrw'],
    stops: { N: ['631N', 'R13N'], S: ['631S', 'R13S'] }
  },
  'dekalb': {
    name: 'DeKalb Ave',
    subtitle: 'N · Q · R · B · D',
    feeds: ['nqrw', 'bdfm'],
    stops: { N: ['R30N', 'D26N'], S: ['R30S', 'D26S'] }
  }
};

const FEED_URLS = {
  '456':    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
  'nqrw':   'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',
  'bdfm':   'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
  'alerts': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fall-alerts'
};

const RELEVANT_LINES = new Set(['R', 'N', 'Q', 'W', '4', '5', '6', 'B', 'D']);

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
  const now = Date.now();
  const cached = feedCache[feedKey];
  if (cached && now - cached.ts < CACHE_TTL) return cached.data;

  const headers = { 'Accept': 'application/x-protobuf' };
  if (process.env.MTA_API_KEY) headers['x-api-key'] = process.env.MTA_API_KEY;

  const res = await fetch(FEED_URLS[feedKey], { headers });
  if (!res.ok) throw new Error(`Feed ${feedKey}: HTTP ${res.status}`);

  const buf = await res.arrayBuffer();
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buf));
  feedCache[feedKey] = { data: feed, ts: now };
  return feed;
}

function extractArrivals(feed, targetStopIds) {
  const nowSec = Math.floor(Date.now() / 1000);
  const arrivals = [];

  for (const entity of feed.entity) {
    if (!entity.tripUpdate) continue;
    const tu = entity.tripUpdate;
    const route = tu.trip?.routeId || '?';

    for (const stu of tu.stopTimeUpdate) {
      if (!targetStopIds.includes(stu.stopId)) continue;
      const timeSec = toSeconds(stu.arrival?.time) || toSeconds(stu.departure?.time);
      if (!timeSec) continue;
      const minutes = Math.round((timeSec - nowSec) / 60);
      if (minutes < 0 || minutes > 90) continue;
      arrivals.push({ stopId: stu.stopId, route, minutes });
    }
  }

  return arrivals;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/arrivals', async (req, res) => {
  try {
    const feedsNeeded = new Set();
    for (const s of Object.values(STATIONS)) s.feeds.forEach(f => feedsNeeded.add(f));

    const feedData = {};
    await Promise.all([...feedsNeeded].map(async f => { feedData[f] = await fetchFeed(f); }));

    const result = {};
    for (const [key, station] of Object.entries(STATIONS)) {
      result[key] = { name: station.name, subtitle: station.subtitle, N: [], S: [] };

      for (const dir of ['N', 'S']) {
        const all = [];
        for (const feedKey of station.feeds) {
          all.push(...extractArrivals(feedData[feedKey], station.stops[dir]));
        }
        all.sort((a, b) => a.minutes - b.minutes);
        result[key][dir] = all.slice(0, 8);
      }
    }

    res.json({ ok: true, data: result, ts: Date.now() });
  } catch (err) {
    console.error('Arrivals error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/alerts', async (req, res) => {
  try {
    const feed = await fetchFeed('alerts');
    const alerts = [];

    for (const entity of feed.entity) {
      if (!entity.alert) continue;
      const alert = entity.alert;

      const lines = [...new Set(
        (alert.informedEntity || [])
          .map(e => e.routeId)
          .filter(r => r && RELEVANT_LINES.has(r))
      )];
      if (lines.length === 0) continue;

      const header = alert.headerText?.translation?.[0]?.text || '';
      const desc   = alert.descriptionText?.translation?.[0]?.text || '';
      if (header) alerts.push({ header, desc, lines });
    }

    res.json({ ok: true, alerts, ts: Date.now() });
  } catch (err) {
    console.error('Alerts error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`MTA Tracker → http://127.0.0.1:${PORT}`);
});
