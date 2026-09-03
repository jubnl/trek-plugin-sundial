// Plugin tests against the SDK's permission-enforcing mock host (`node --test`).
// The dev fixtures double as the test fixtures, so what you see in `trek-plugin dev`
// is exactly what these assertions run over. The mock's own db is a recorder, so
// own-data reads are canned through `queryResults` (keyed by the exact SQL).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockHost, PermissionDenied } = require('trek-plugin-sdk/testing');
const manifest = require('../trek-plugin.json');
const fixtures = require('../dev-fixtures.json');
const plugin = require('../server/index.js');

const SHOOT_SQL = 'SELECT day_id, note, user_id, created_at FROM shoot_days WHERE trip_id = ? ORDER BY day_id';
const PREFS_SQL = 'SELECT zone FROM trip_prefs WHERE trip_id = ?';
const INDEX_SQL = 'SELECT trip_id, day_id, date, zone, lat, lng FROM place_index WHERE place_id = ?';

const ADA = { id: 1, username: 'ada', isAdmin: false };

function host(overrides = {}) {
  return createMockHost({
    ...fixtures,
    grants: manifest.permissions,
    ...overrides,
    queryResults: { ...(overrides.queryResults || {}) },
  });
}

function req(method, path, extra = {}) {
  return { method, path, query: {}, body: null, user: ADA, headers: {}, ...extra };
}

async function tripModel(h, tripId = 1) {
  const r = await h.run(plugin).route({ method: 'GET', path: '/trip' }, req('GET', '/trip', { query: { tripId: String(tripId) } }));
  return { status: r.status, body: JSON.parse(r.body) };
}

// ─── manifest ↔ code consistency (the traps nothing else checks) ─────────────

test('every MCP tool declared in the manifest is implemented, and vice versa', () => {
  const declared = manifest.capabilities.mcpTools.map((t) => t.name).sort();
  const implemented = [...plugin.hooks.mcpToolProvider.tools].sort();
  assert.deepEqual(declared, implemented);
});

test('every hook and entry point the code implements has its grant in the manifest', () => {
  const p = new Set(manifest.permissions);
  const need = {
    dayScheduleProvider: 'hook:day-schedule-provider',
    dayTintProvider: 'hook:day-tint-provider',
    placeDetailProvider: 'hook:place-detail-provider',
    warningProvider: 'hook:trip-warning-provider',
    pdfSectionProvider: 'hook:pdf-section-provider',
    tripCardProvider: 'hook:trip-card-provider',
    mcpToolProvider: 'mcp:tools',
  };
  for (const [hook, grant] of Object.entries(need)) {
    if (plugin.hooks[hook]) assert.ok(p.has(grant), `${hook} needs ${grant}`);
  }
  if (plugin.events?.length) assert.ok(p.has('events:subscribe'));
  if (plugin.deleteUserData || plugin.exportUserData) assert.ok(p.has('hook:user-data'));
  assert.equal(plugin.jobs, undefined, 'no jobs declared, so jobs:run is rightly absent');
});

// ─── routes ─────────────────────────────────────────────────────────────────

test('GET /trip builds the model: anchors, zone, sun times, sky, summary', async () => {
  const h = host();
  await h.run(plugin).load();
  const { status, body } = await tripModel(h);
  assert.equal(status, 200);
  assert.equal(body.days.length, 8);
  assert.deepEqual(body.days.map((d) => d.anchor.source), ['stop', 'stop', 'stop', 'stop', 'stay', 'stop', 'stop', 'carry']);
  assert.equal(body.days[4].anchor.name, 'Ryokan Gion', 'a free day sleeps at the ryokan');
  assert.equal(body.days[7].anchor.name, 'Lake Kawaguchi', 'the last day carries the previous location');
  assert.equal(body.zone.source, 'auto');
  assert.equal(body.days[0].zone, 'Asia/Tokyo');
  assert.equal(body.days[0].zoneMethod, 'region');
  assert.equal(body.days[0].sun.times.sunrise, '05:15');
  assert.equal(body.days[0].sun.times.sunset, '18:03');
  assert.equal(body.summary.computed, 8);
  assert.equal(body.summary.latestSunset.day, 6);
  assert.ok(body.days.every((d) => d.sky && d.sky.sunset && d.sky.sunset.main === 'Clear'), 'forecast sky attached from the weather broker');
  assert.ok(h.calls.some((c) => c.method === 'weather.get'));
  assert.ok(h.calls.some((c) => c.method === 'db.tx'), 'the place index is refreshed');
});

test('GET /trip honours the user settings (12h clock, generous golden hour) and a pinned zone', async () => {
  const h = host({
    userSettings: { clock: '12h', golden_altitude: '10' },
    queryResults: { [PREFS_SQL]: [{ zone: 'Asia/Tokyo' }] },
  });
  const { body } = await tripModel(h);
  assert.equal(body.zone.name, 'Asia/Tokyo');
  assert.equal(body.zone.source, 'user');
  assert.equal(body.settings.clock, '12h');
  assert.equal(body.settings.goldenAltitude, 10);
  assert.match(body.days[0].sun.times.sunrise, /^5:15am$/);
  assert.ok(body.days[0].sun.minutes.goldenDawnEnd > body.days[0].sun.minutes.sunrise + 40, 'a 10-degree golden hour runs long');
});

test('GET /trip refuses a trip the acting user is not a member of, and validates tripId', async () => {
  const h = host();
  const foreign = await tripModel(h, 2);
  assert.equal(foreign.status, 403);
  assert.match(foreign.body.error, /RESOURCE_FORBIDDEN/);
  const bad = await h.run(plugin).route({ method: 'GET', path: '/trip' }, req('GET', '/trip', { query: { tripId: 'nope' } }));
  assert.equal(bad.status, 400);
});

test('POST /shoot-day writes own data, mirrors to meta best-effort, and pings the trip', async () => {
  const h = host();
  const r = await h.run(plugin).route({ method: 'POST', path: '/shoot-day' }, req('POST', '/shoot-day', { body: { tripId: 1, dayId: 104, on: true, note: '  Fushimi at dawn  ' } }));
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { dayId: 104, on: true, note: 'Fushimi at dawn' });
  assert.ok(h.calls.some((c) => c.method === 'db.exec'));
  assert.ok(h.calls.some((c) => c.method === 'meta.set'));
  assert.deepEqual(h.broadcasts.map((b) => [b.kind, b.target, b.event]), [['trip', 1, 'shoot-day']]);
});

test('POST /shoot-day rejects a day from another trip and a foreign trip', async () => {
  const h = host();
  const wrongDay = await h.run(plugin).route({ method: 'POST', path: '/shoot-day' }, req('POST', '/shoot-day', { body: { tripId: 1, dayId: 201, on: true } }));
  assert.equal(wrongDay.status, 400);
  const foreign = await h.run(plugin).route({ method: 'POST', path: '/shoot-day' }, req('POST', '/shoot-day', { body: { tripId: 2, dayId: 201, on: true } }));
  assert.equal(foreign.status, 403);
});

test('POST /zone validates the IANA name and clears on an empty string', async () => {
  const h = host();
  const drv = h.run(plugin);
  const ok = await drv.route({ method: 'POST', path: '/zone' }, req('POST', '/zone', { body: { tripId: 1, zone: 'Asia/Tokyo' } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { zone: 'Asia/Tokyo' });
  const bad = await drv.route({ method: 'POST', path: '/zone' }, req('POST', '/zone', { body: { tripId: 1, zone: 'Mars/Olympus' } }));
  assert.equal(bad.status, 400);
  const clear = await drv.route({ method: 'POST', path: '/zone' }, req('POST', '/zone', { body: { tripId: 1, zone: '' } }));
  assert.deepEqual(JSON.parse(clear.body), { zone: null });
  assert.ok(h.calls.some((c) => c.method === 'meta.delete'));
});

// ─── hooks ──────────────────────────────────────────────────────────────────

test('dayScheduleProvider: a start and an end row per day, inside the host budget', async () => {
  const rows = await host().run(plugin).hook('dayScheduleProvider', 'getSchedule', 1);
  assert.equal(rows.length, 16);
  assert.ok(rows.length <= 60);
  assert.equal(rows[0].dayId, 101);
  assert.equal(rows[0].position, 'start');
  assert.match(rows[0].label, /^Sunrise 05:15, golden hour until 05:49$/);
  assert.equal(rows[1].position, 'end');
  assert.match(rows[1].label, /^Golden hour from 17:29, sunset 18:03$/);
  assert.ok(rows.every((r) => r.label.length <= 120 && !r.minutes), 'no minutes: sun rows must not inflate the day total');
});

test('dayTintProvider paints shoot days gold from own data only', async () => {
  const h = host({ queryResults: { [SHOOT_SQL]: [{ day_id: 104, note: 'Fushimi at dawn', user_id: 1 }] } });
  const tints = await h.run(plugin).hook('dayTintProvider', 'getDayTints', 1);
  assert.deepEqual(tints, [{ dayId: 104, badgeColor: '#f59e0b', headerColor: '#f59e0b', label: 'Shoot day: Fushimi at dawn' }]);
  assert.ok(!h.calls.some((c) => c.method.startsWith('trips.')), 'tints never read core data');
});

test('placeDetailProvider answers from the place index alone', async () => {
  const h = host({ queryResults: { [INDEX_SQL]: [{ trip_id: 1, day_id: 104, date: '2026-09-08', zone: 'Asia/Tokyo', lat: 34.9671, lng: 135.7727 }] } });
  const rows = await h.run(plugin).hook('placeDetailProvider', 'getDetails', 17);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { label: 'Sunrise', value: '05:34 (2026-09-08)' });
  assert.equal(rows[3].label, 'Sunset');
  assert.ok(rows.every((r) => r.label.length <= 60 && r.value.length <= 200));
  assert.deepEqual(await host().run(plugin).hook('placeDetailProvider', 'getDetails', 999), [], 'unknown place: nothing, never a throw');
});

test('warningProvider flags stops before sunrise and after sunset, and unlocated shoot days', async () => {
  const w = await host().run(plugin).hook('warningProvider', 'getWarnings', 1);
  assert.equal(w.length, 2);
  assert.equal(w[0].level, 'info');
  assert.match(w[0].message, /Fushimi Inari Taisha.*05:00, before sunrise \(05:34\)/);
  assert.equal(w[0].placeId, 17);
  assert.match(w[1].message, /Itsukushima Shrine.*20:30, after sunset/);

  const bare = structuredClone(fixtures);
  bare.trips[1].places = [];
  bare.trips[1].accommodations = [];
  for (const d of bare.trips[1].days) d.assignments = [];
  const h = createMockHost({ ...bare, grants: manifest.permissions, queryResults: { [SHOOT_SQL]: [{ day_id: 105, note: null, user_id: 1 }] } });
  const w2 = await h.run(plugin).hook('warningProvider', 'getWarnings', 1);
  assert.equal(w2.length, 1);
  assert.equal(w2[0].level, 'warning');
  assert.match(w2[0].message, /Day 5 .* shoot day .* no located stop/);
});

test('pdfSectionProvider: a table with a row per day plus a shoot-day section', async () => {
  const h = host({ queryResults: { [SHOOT_SQL]: [{ day_id: 104, note: 'Fushimi at dawn', user_id: 1 }] } });
  const sections = await h.run(plugin).hook('pdfSectionProvider', 'getSections', 1);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, 'Sun and light');
  assert.equal(sections[0].table.headers.length, 8);
  assert.equal(sections[0].table.rows.length, 8);
  assert.equal(sections[0].table.rows[3][2], 'Fushimi Inari Taisha');
  assert.match(sections[1].paragraphs[0], /^Day 4 \(2026-09-08\) at Fushimi Inari Taisha: Fushimi at dawn$/);
});

test('tripCardProvider: one badge per trip with marks, nothing for the rest, no core reads', async () => {
  const sql = 'SELECT trip_id, COUNT(*) AS n FROM shoot_days WHERE trip_id IN (?,?) GROUP BY trip_id';
  const h = host({ queryResults: { [sql]: [{ trip_id: 1, n: 2 }] } });
  const cards = await h.run(plugin).hook('tripCardProvider', 'getCards', [1, 2]);
  assert.deepEqual(cards, [{ tripId: 1, id: 'shoot-days', label: 'Shoot days', value: '2', icon: 'Camera', tone: 'default' }]);
  assert.ok(!h.calls.some((c) => c.method.startsWith('trips.')));
  assert.deepEqual(await host().run(plugin).hook('tripCardProvider', 'getCards', []), []);
});

// ─── MCP tools ──────────────────────────────────────────────────────────────

test('sun_times answers for a trip, one day, or a bare coordinate', async () => {
  const drv = host().run(plugin);
  const all = await drv.hook('mcpToolProvider', 'callTool', { name: 'sun_times', args: { tripId: 1 } });
  assert.equal(all.days.length, 8);
  assert.equal(all.days[3].sun.sunrise, '05:34');
  const one = await drv.hook('mcpToolProvider', 'callTool', { name: 'sun_times', args: { tripId: 1, dayId: 104 } });
  assert.equal(one.where.name, 'Fushimi Inari Taisha');
  assert.equal(one.sun.goldenHourMorning, '05:18-06:07');
  const spot = await drv.hook('mcpToolProvider', 'callTool', { name: 'sun_times', args: { date: '2026-06-21', lat: 51.5074, lng: -0.1278, zone: 'Europe/London' } });
  assert.equal(spot.sunrise, '04:43');
  assert.equal(spot.sunset, '21:21');
  await assert.rejects(drv.hook('mcpToolProvider', 'callTool', { name: 'sun_times', args: { tripId: 2 } }), /RESOURCE_FORBIDDEN/);
  await assert.rejects(drv.hook('mcpToolProvider', 'callTool', { name: 'sun_times', args: {} }), /pass tripId/);
});

test('mark_shoot_day and list_shoot_days share the route logic', async () => {
  const h = host({ queryResults: { [SHOOT_SQL]: [{ day_id: 106, note: 'torii at dusk', user_id: null }] } });
  const drv = h.run(plugin);
  const marked = await drv.hook('mcpToolProvider', 'callTool', { name: 'mark_shoot_day', args: { tripId: 1, dayId: 106, on: true, note: 'torii at dusk' } });
  assert.deepEqual(marked, { dayId: 106, on: true, note: 'torii at dusk' });
  const list = await drv.hook('mcpToolProvider', 'callTool', { name: 'list_shoot_days', args: { tripId: 1 } });
  assert.equal(list.shootDays.length, 1);
  assert.equal(list.shootDays[0].where.name, 'Itsukushima Shrine');
  await assert.rejects(drv.hook('mcpToolProvider', 'callTool', { name: 'nonsense', args: {} }), /unknown tool/);
});

// ─── background: events + GDPR (userless) ──────────────────────────────────

test('day:deleted and trip:deleted clean own rows without any core read', async () => {
  const h = host();
  const drv = h.run(plugin);
  await drv.event('day:deleted', { tripId: 1, entity: 'day', entityId: 104 });
  await drv.event('trip:deleted', { tripId: 1 });
  const methods = h.calls.map((c) => c.method);
  assert.ok(methods.includes('db.exec') && methods.includes('db.tx'));
  assert.ok(!methods.some((m) => m.startsWith('trips.')));
});

test('GDPR: erasure detaches the author, export returns only the user\'s rows', async () => {
  const h = host({
    queryResults: {
      'SELECT trip_id, day_id, note, created_at FROM shoot_days WHERE user_id = ?': [{ trip_id: 1, day_id: 104, note: 'x', created_at: 't' }],
      'SELECT trip_id, zone, updated_at FROM trip_prefs WHERE updated_by = ?': [],
    },
  });
  const drv = h.run(plugin);
  await drv.deleteUserData(1);
  const out = await drv.exportUserData(1);
  assert.deepEqual(out, { shootDays: [{ trip_id: 1, day_id: 104, note: 'x', created_at: 't' }], tripZones: [] });
});

// ─── grants: what breaks when one is missing ───────────────────────────────

test('without the hook grants the driver refuses, exactly as TREK would silently skip', async () => {
  const bare = createMockHost({ ...fixtures, grants: ['db:own', 'db:read:trips'] }).run(plugin);
  await assert.rejects(bare.hook('dayScheduleProvider', 'getSchedule', 1), PermissionDenied);
  await assert.rejects(bare.hook('mcpToolProvider', 'callTool', { name: 'sun_times', args: { tripId: 1 } }), PermissionDenied);
  await assert.rejects(bare.event('day:deleted', { tripId: 1, entityId: 1 }), PermissionDenied);
  await assert.rejects(bare.deleteUserData(1), PermissionDenied);
});

test('without db:meta, weather:read and ws:broadcast:trip the routes still succeed (best-effort extras)', async () => {
  const h = createMockHost({ ...fixtures, grants: ['db:own', 'db:read:trips'] });
  const drv = h.run(plugin);
  const model = await drv.route({ method: 'GET', path: '/trip' }, req('GET', '/trip', { query: { tripId: '1' } }));
  assert.equal(model.status, 200);
  assert.equal(JSON.parse(model.body).days[0].sky, null, 'no weather grant: no sky, no failure');
  const mark = await drv.route({ method: 'POST', path: '/shoot-day' }, req('POST', '/shoot-day', { body: { tripId: 1, dayId: 104, on: true } }));
  assert.equal(mark.status, 200);
  assert.equal(h.broadcasts.length, 0);
});

// ─── 1.1.0: polar / high-latitude answers, shootDay shape, zone in trip mode ─

const SVALBARD = { date: '2026-12-15', lat: 78.2232, lng: 15.6267, zone: 'Arctic/Longyearbyen' };
const TROMSO_JAN = { date: '2026-01-25', lat: 69.6496, lng: 18.956, zone: 'Europe/Oslo' };
const HELSINKI_JUNE = { date: '2026-06-21', lat: 60.1699, lng: 24.9384, zone: 'Europe/Helsinki' };

test('sun_times never emits "null-null": polar night yields nulls, not strings', async () => {
  const r = await host().run(plugin).hook('mcpToolProvider', 'callTool', { name: 'sun_times', args: SVALBARD });
  assert.equal(r.polar, 'night');
  assert.equal(r.dayLength, '0h 00m');
  for (const k of ['sunrise', 'sunset', 'blueHourMorning', 'goldenHourMorning', 'goldenHourEvening', 'blueHourEvening', 'solarNoon' === 'x' ? 'x' : 'astronomicalDawn']) {
    if (k === 'astronomicalDawn') continue; // astronomical twilight does exist at noon there
    assert.equal(r[k], null, `${k} should be null`);
  }
  assert.ok(!JSON.stringify(r).includes('null-'), 'no half-formed ranges');
  assert.equal(r.zoneSource, 'request');
});

test('low winter sun that rises but never leaves the golden hour: morning golden range is null, rows say so', async () => {
  const drv = host().run(plugin);
  const r = await drv.hook('mcpToolProvider', 'callTool', { name: 'sun_times', args: TROMSO_JAN });
  assert.equal(r.polar, null);
  assert.ok(r.sunrise && r.sunset, 'the sun does rise');
  assert.equal(r.goldenHourMorning, null);
  assert.equal(r.goldenHourEvening, null);
  assert.ok(r.blueHourMorning, 'blue hour still happens');
  const { scheduleRows, pdfSections } = plugin.__internals;
  const { buildTripModel } = require('../server/model.js');
  const model = buildTripModel({
    trip: { id: 5, start_date: '2026-01-25' },
    days: [{ id: 1, day_number: 1, date: '2026-01-25', assignments: [{ id: 1, place_id: 1, place: { id: 1, name: 'Tromso', lat: 69.6496, lng: 18.956 } }] }],
    zone: 'Europe/Oslo',
  });
  const rows = scheduleRows(model);
  assert.match(rows[0].label, /low sun all day/);
  assert.match(rows[1].label, /^Sunset \d\d:\d\d$/);
  assert.equal(pdfSections(model)[0].table.rows[0][4], 'all day');
  assert.ok(!rows.some((x) => /null/.test(x.label)));
});

test('midsummer at 63N: the sun sets but never leaves the golden band, so blue/golden evening ranges are null and 00:30 is golden', async () => {
  const TRONDHEIM = { date: '2026-06-21', lat: 63.4305, lng: 10.3951, zone: 'Europe/Oslo' };
  const r = await host().run(plugin).hook('mcpToolProvider', 'callTool', { name: 'sun_times', args: TRONDHEIM });
  assert.equal(r.polar, null);
  assert.equal(r.sunset, '23:38');
  assert.equal(r.blueHourEvening, null, 'civil twilight never ends');
  assert.equal(r.goldenHourEvening, null, 'golden light runs through the night, so the range has no end');
  assert.equal(r.goldenHourMorning, null);
  assert.ok(!JSON.stringify(r).includes('null-'));
  const { lightAt, present } = require('../server/model.js');
  const s = present(require('../server/sun.js').sunTimes(TRONDHEIM), '24h');
  assert.equal(lightAt(30, s), 'golden');
  assert.equal(lightAt(12 * 60, s), 'day');
  assert.equal(lightAt(22 * 60 + 30, s), 'golden');
});

test('shootDay is always an object, and both sun_times modes share one field order', async () => {
  const drv = host({ queryResults: { [SHOOT_SQL]: [{ day_id: 104, note: 'x', user_id: 1 }] } }).run(plugin);
  const all = await drv.hook('mcpToolProvider', 'callTool', { name: 'sun_times', args: { tripId: 1 } });
  assert.deepEqual(all.days[0].shootDay, { on: false, note: null });
  assert.deepEqual(all.days[3].shootDay, { on: true, note: 'x' });
  const spot = await drv.hook('mcpToolProvider', 'callTool', { name: 'sun_times', args: { date: '2026-09-05', lat: 35.7148, lng: 139.7967, zone: 'Asia/Tokyo' } });
  const spotKeys = Object.keys(spot).filter((k) => !['date', 'zone', 'zoneSource', 'zoneMethod'].includes(k));
  assert.deepEqual(Object.keys(all.days[0].sun), spotKeys);
  assert.equal(all.days[0].sun.sunrise, spot.sunrise);
});

test('zone is honoured in trip mode (request-scoped) and flags days far from a pinned zone', async () => {
  const drv = host().run(plugin);
  const r = await drv.hook('mcpToolProvider', 'callTool', { name: 'sun_times', args: { tripId: 1, zone: 'Europe/Zurich' } });
  assert.deepEqual(r.zone, { name: 'Europe/Zurich', source: 'request' });
  assert.equal(r.days[0].zone, 'Europe/Zurich');
  assert.match(r.days[0].sun.sunrise, /^22:1\d$/, 'Tokyo sunrise on Zurich clocks is the previous evening');
  assert.equal(r.summary.zoneMismatches, 8);
  assert.deepEqual(r.days[0].zoneMismatch, { pinned: 'Europe/Zurich', pinnedOffset: 120, estimatedZone: 'Asia/Tokyo', estimatedOffset: 540 });
  await assert.rejects(drv.hook('mcpToolProvider', 'callTool', { name: 'sun_times', args: { tripId: 1, zone: 'Mars/Olympus' } }), /unknown time zone/);

  const pinned = host({ queryResults: { [PREFS_SQL]: [{ zone: 'Europe/Zurich' }] } }).run(plugin);
  const w = await pinned.hook('warningProvider', 'getWarnings', 1);
  assert.equal(w.filter((x) => /pinned zone Europe\/Zurich is UTC\+2/.test(x.message)).length, 8);
  assert.ok(w.every((x) => x.message.length <= 300));
  const tokyo = await host({ queryResults: { [PREFS_SQL]: [{ zone: 'Asia/Tokyo' }] } }).run(plugin).hook('warningProvider', 'getWarnings', 1);
  assert.equal(tokyo.length, 2, 'a matching pinned zone raises nothing');

  // The forecast sky is read at the LOCATION's hour (the fixture's local sunset 18:05 → Clear),
  // never at the pinned zone's hour (11:xx → Clouds).
  const zurich = await tripModel(host({ queryResults: { [PREFS_SQL]: [{ zone: 'Europe/Zurich' }] } }));
  assert.match(zurich.body.days[0].sun.times.sunset, /^11:0\d$/);
  assert.equal(zurich.body.days[0].sky.sunset.main, 'Clear');
  assert.equal(zurich.body.days[0].sky.sunrise.main, 'Clear');
});
