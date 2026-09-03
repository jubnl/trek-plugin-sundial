// Sundial — sunrise, sunset, golden hour and blue hour for every day of a trip,
// computed from where you will actually be that day.
//
// One model (loadTrip) feeds everything: the trip tab's route, six provider hooks
// that TREK renders natively, and three MCP tools. The solar maths is in sun.js,
// the "where are we each day" logic in model.js; this file is the ctx plumbing.
//
// Runs in TREK's isolated plugin child. No egress, no filesystem: the only
// external input is the host's weather broker (tenant-free, cached by TREK).
'use strict';

const { definePlugin } = require('trek-plugin-sdk');
const sun = require('./sun.js');
const { buildTripModel, lightAt } = require('./model.js');

const JSON_HEADERS = { 'content-type': 'application/json' };
const WEATHER_WINDOW_DAYS = 16; // Open-Meteo's forecast horizon — beyond it there is nothing to ask
const MAX_WEATHER_CALLS = 16; // per route call; keeps well inside the per-plugin RPC burst
const SHOOT_NOTE_MAX = 200;
const SHOOT_COLOR = '#f59e0b';

// ─── helpers ────────────────────────────────────────────────────────────────

function json(status, body) {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

/** Run a thunk, swallow failure. Catches the synchronous throw of a missing ctx namespace too. */
async function attempt(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function intOf(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/** Map a thrown ctx error onto an HTTP status the frame can act on. */
function statusFor(e) {
  const m = String((e && e.message) || e);
  if (m.startsWith('RESOURCE_FORBIDDEN') || m.startsWith('PERMISSION_DENIED')) return 403;
  if (m.startsWith('BAD_PARAMS')) return 400;
  if (m.startsWith('TIMEOUT')) return 504;
  return 500;
}

function fail(e) {
  const status = statusFor(e);
  return json(status, { error: String((e && e.message) || e).slice(0, 300) });
}

// ─── own data ───────────────────────────────────────────────────────────────

const MIGRATIONS = [
  ['001_trip_prefs', 'CREATE TABLE IF NOT EXISTS trip_prefs (trip_id INTEGER PRIMARY KEY, zone TEXT, updated_by INTEGER, updated_at TEXT NOT NULL)'],
  ['002_shoot_days', 'CREATE TABLE IF NOT EXISTS shoot_days (trip_id INTEGER NOT NULL, day_id INTEGER NOT NULL, note TEXT, user_id INTEGER, created_at TEXT NOT NULL, PRIMARY KEY (trip_id, day_id))'],
  ['003_place_index', 'CREATE TABLE IF NOT EXISTS place_index (place_id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL, day_id INTEGER, date TEXT, zone TEXT, lat REAL, lng REAL, name TEXT, updated_at TEXT NOT NULL)'],
  ['004_place_index_trip', 'CREATE INDEX IF NOT EXISTS place_index_trip ON place_index (trip_id)'],
];

async function readPrefs(ctx, tripId) {
  const rows = await ctx.db.query('SELECT zone FROM trip_prefs WHERE trip_id = ?', tripId);
  return rows[0] || null;
}

async function readShootDays(ctx, tripId) {
  return ctx.db.query('SELECT day_id, note, user_id, created_at FROM shoot_days WHERE trip_id = ? ORDER BY day_id', tripId);
}

async function userSettings(ctx) {
  const golden = await attempt(() => ctx.settings.get('golden_altitude'), undefined);
  const clock = await attempt(() => ctx.settings.get('clock'), undefined);
  return { goldenAltitude: sun.clampGolden(golden ?? 6), clock: clock === '12h' ? '12h' : '24h' };
}

/**
 * Keep place_index fresh so placeDetailProvider can answer from own data alone
 * (it receives only a placeId, and must not fan out over every trip to find it).
 */
async function refreshPlaceIndex(ctx, model, places) {
  const now = new Date().toISOString();
  const firstDay = model.days[0] || null;
  const dayOfPlace = new Map();
  for (const d of model.days) for (const s of d.stops) if (s.placeId != null && !dayOfPlace.has(s.placeId)) dayOfPlace.set(s.placeId, d);
  const ops = [{ sql: 'DELETE FROM place_index WHERE trip_id = ?', args: [model.trip.id] }];
  for (const p of Array.isArray(places) ? places : []) {
    const lat = Number(p.lat);
    const lng = Number(p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const day = dayOfPlace.get(p.id) || firstDay;
    ops.push({
      sql: 'INSERT OR REPLACE INTO place_index (place_id, trip_id, day_id, date, zone, lat, lng, name, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      args: [p.id, model.trip.id, day ? day.id : null, day ? day.date : null, day ? day.zone : model.zone.name, lat, lng, String(p.name || ''), now],
    });
  }
  // db.tx takes at most 100 statements — chunk, and never let bookkeeping fail a read.
  for (let i = 0; i < ops.length; i += 100) await attempt(() => ctx.db.tx(ops.slice(i, i + 100)));
}

// ─── the model ──────────────────────────────────────────────────────────────

/**
 * Read a trip (membership-checked by the host against the acting user) and build
 * the per-day sun model. `weather: true` also asks the host's forecast broker for
 * the sky at sunrise/sunset on days inside the forecast window.
 */
async function loadTrip(ctx, tripId, opts = {}) {
  const trip = await ctx.trips.getById(tripId);
  if (!trip) return null;
  const [days, accommodations, places, prefs, shootDays, settings] = await Promise.all([
    ctx.trips.getDays(tripId),
    attempt(() => ctx.trips.getAccommodations(tripId), []),
    ctx.trips.getPlaces(tripId),
    readPrefs(ctx, tripId),
    readShootDays(ctx, tripId),
    userSettings(ctx),
  ]);
  const model = buildTripModel({ trip, days, accommodations, places, zone: prefs ? prefs.zone : null, shootDays, ...settings });
  if (opts.index !== false) await refreshPlaceIndex(ctx, model, places);
  if (opts.weather) await addSky(ctx, model);
  return model;
}

/** Forecast sky at sunrise and sunset, only for days the forecast can cover. */
async function addSky(ctx, model) {
  const today = isoToday();
  let calls = 0;
  for (const d of model.days) {
    d.sky = null;
    if (!d.sun || !d.anchor || !d.date || calls >= MAX_WEATHER_CALLS) continue;
    const ahead = daysBetween(today, d.date);
    if (ahead < 0 || ahead >= WEATHER_WINDOW_DAYS) continue;
    calls++;
    const w = await attempt(() => ctx.weather.get(d.anchor.lat, d.anchor.lng, d.date), null);
    if (!w || typeof w !== 'object' || w.error) continue;
    const hourly = Array.isArray(w.hourly) ? w.hourly : [];
    const at = (minutes) => {
      if (minutes === null || minutes === undefined) return null;
      const h = ((Math.floor(minutes / 60) % 24) + 24) % 24;
      const row = hourly.find((x) => Number(x.hour) === h);
      return row ? { main: String(row.main || ''), precipitation: Number(row.precipitation_probability ?? row.precipitation ?? 0) } : null;
    };
    d.sky = {
      summary: typeof w.main === 'string' ? w.main : null,
      description: typeof w.description === 'string' ? w.description : null,
      sunrise: at(d.sun.minutes.sunrise),
      sunset: at(d.sun.minutes.sunset),
      precipitationMax: Number.isFinite(Number(w.precipitation_probability_max)) ? Number(w.precipitation_probability_max) : null,
    };
  }
}

/** The one write path for shoot-day marks — shared by the route and the MCP tool. */
async function setShootDay(ctx, { tripId, dayId, on, note, userId }) {
  const model = await loadTrip(ctx, tripId, { index: false });
  if (!model) throw new Error('RESOURCE_FORBIDDEN: trip not found');
  const day = model.days.find((d) => d.id === dayId);
  if (!day) throw new Error('BAD_PARAMS: dayId does not belong to this trip');
  const clean = typeof note === 'string' ? note.trim().slice(0, SHOOT_NOTE_MAX) : null;
  if (on) {
    await ctx.db.exec(
      'INSERT INTO shoot_days (trip_id, day_id, note, user_id, created_at) VALUES (?,?,?,?,?) ON CONFLICT(trip_id, day_id) DO UPDATE SET note = excluded.note',
      tripId, dayId, clean, userId ?? null, new Date().toISOString(),
    );
  } else {
    await ctx.db.exec('DELETE FROM shoot_days WHERE trip_id = ? AND day_id = ?', tripId, dayId);
  }
  // Own db is the source of truth; the core-entity mirror is best-effort (hosts can lack ctx.meta).
  await attempt(() => (on ? ctx.meta.set('day', dayId, 'shoot', { on: true, note: clean }) : ctx.meta.delete('day', dayId, 'shoot')));
  await attempt(() => ctx.ws.broadcastToTrip(tripId, 'shoot-day', { dayId, on }));
  return { dayId, on: !!on, note: on ? clean : null };
}

async function setZone(ctx, { tripId, zone, userId }) {
  const trip = await ctx.trips.getById(tripId);
  if (!trip) throw new Error('RESOURCE_FORBIDDEN: trip not found');
  const wanted = typeof zone === 'string' ? zone.trim() : '';
  if (wanted && !sun.isValidZone(wanted)) throw new Error('BAD_PARAMS: unknown time zone');
  if (wanted) {
    await ctx.db.exec(
      'INSERT INTO trip_prefs (trip_id, zone, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(trip_id) DO UPDATE SET zone = excluded.zone, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
      tripId, wanted, userId ?? null, new Date().toISOString(),
    );
  } else {
    await ctx.db.exec('DELETE FROM trip_prefs WHERE trip_id = ?', tripId);
  }
  await attempt(() => (wanted ? ctx.meta.set('trip', tripId, 'zone', wanted) : ctx.meta.delete('trip', tripId, 'zone')));
  await attempt(() => ctx.ws.broadcastToTrip(tripId, 'zone', { zone: wanted || null }));
  return { zone: wanted || null };
}

// ─── text for host-rendered surfaces (emoji-free, length-capped by the host) ─

function dayLabel(d) {
  return `Day ${d.number}` + (d.date ? ` (${d.date})` : '');
}

function morningLine(d) {
  const s = d.sun;
  if (s.polar === 'day') return 'Midnight sun: the sun never sets today';
  if (s.polar === 'night') return s.times.civilDawn ? `Polar night: civil twilight ${s.times.civilDawn} to ${s.times.civilDusk}` : 'Polar night: no daylight today';
  return `Sunrise ${s.times.sunrise}, golden hour until ${s.times.goldenDawnEnd}`;
}

function eveningLine(d) {
  const s = d.sun;
  if (s.polar) return null;
  return `Golden hour from ${s.times.goldenDuskStart}, sunset ${s.times.sunset}`;
}

/** Days > 30: one row per day keeps the ≤60-item budget; otherwise a start and an end row. */
function scheduleRows(model) {
  const rows = [];
  const lit = model.days.filter((d) => d.sun);
  const compact = lit.length > 30;
  for (const d of lit) {
    const s = d.sun;
    if (compact) {
      const label = s.polar ? morningLine(d) : `Sun ${s.times.sunrise} to ${s.times.sunset}, golden ${s.times.blueDawnEnd}-${s.times.goldenDawnEnd} and ${s.times.goldenDuskStart}-${s.times.blueDuskStart}`;
      rows.push({ id: `sun-${d.id}`, dayId: d.id, position: 'start', label, tone: d.shoot.on ? 'warn' : 'default' });
      continue;
    }
    rows.push({ id: `dawn-${d.id}`, dayId: d.id, position: 'start', label: morningLine(d), tone: 'default' });
    const evening = eveningLine(d);
    if (evening) rows.push({ id: `dusk-${d.id}`, dayId: d.id, position: 'end', label: evening, tone: 'default' });
  }
  return rows.slice(0, 60);
}

function warningsFor(model) {
  const out = [];
  for (const d of model.days) {
    if (d.shoot.on && !d.sun) {
      out.push({ level: 'warning', message: `${dayLabel(d)} is marked as a shoot day but has no located stop or stay, so its sun times are unknown`, dayId: d.id });
      continue;
    }
    if (!d.sun || d.sun.polar) continue;
    const m = d.sun.minutes;
    for (const s of d.stops) {
      if (s.minutes === null) continue;
      if (m.sunrise !== null && s.minutes < m.sunrise) {
        out.push({ level: 'info', message: `"${s.name}" starts at ${s.time}, before sunrise (${d.sun.times.sunrise}) on ${dayLabel(d)}`, dayId: d.id, placeId: s.placeId ?? undefined });
      } else if (m.sunset !== null && s.minutes > m.sunset) {
        out.push({ level: 'info', message: `"${s.name}" starts at ${s.time}, after sunset (${d.sun.times.sunset}) on ${dayLabel(d)}`, dayId: d.id, placeId: s.placeId ?? undefined });
      }
    }
  }
  return out.slice(0, 20);
}

function pdfSections(model) {
  const zoneNote = model.zone.name ? `Times are shown in ${model.zone.name}.` : 'Times are shown in a zone estimated from each day\'s longitude; set the trip zone in the Sundial tab for exact local time.';
  const rows = model.days.slice(0, 50).map((d) => {
    const s = d.sun;
    if (!s) return [String(d.number), d.date || '', d.anchor ? d.anchor.name : 'no location', '', '', '', '', ''];
    if (s.polar === 'day') return [String(d.number), d.date || '', d.anchor.name, 'midnight sun', '', '', '', '24h 00m'];
    if (s.polar === 'night') return [String(d.number), d.date || '', d.anchor.name, 'polar night', '', '', '', '0h 00m'];
    return [String(d.number), d.date || '', d.anchor.name, s.times.sunrise, `${s.times.blueDawnEnd}-${s.times.goldenDawnEnd}`, `${s.times.goldenDuskStart}-${s.times.blueDuskStart}`, s.times.sunset, s.dayLength];
  });
  const sections = [{
    title: 'Sun and light',
    paragraphs: [zoneNote, `Golden hour is counted from 4 degrees below the horizon to ${model.settings.goldenAltitude} degrees above it.`],
    table: { headers: ['Day', 'Date', 'Where', 'Sunrise', 'Golden (am)', 'Golden (pm)', 'Sunset', 'Daylight'], rows },
  }];
  const shoot = model.days.filter((d) => d.shoot.on);
  if (shoot.length) {
    sections.push({
      title: 'Shoot days',
      paragraphs: shoot.map((d) => `${dayLabel(d)}${d.anchor ? ' at ' + d.anchor.name : ''}${d.shoot.note ? ': ' + d.shoot.note : ''}`).slice(0, 20),
    });
  }
  return sections;
}

/** Compact per-day facts for an assistant — strings only, no markup. */
function compactDay(d) {
  return {
    dayId: d.id,
    day: d.number,
    date: d.date,
    where: d.anchor ? { name: d.anchor.name, lat: d.anchor.lat, lng: d.anchor.lng, source: d.anchor.source } : null,
    zone: d.zone,
    shootDay: d.shoot.on ? { note: d.shoot.note } : false,
    sun: d.sun
      ? {
          polar: d.sun.polar,
          sunrise: d.sun.times.sunrise,
          sunset: d.sun.times.sunset,
          goldenHourMorning: d.sun.polar ? null : `${d.sun.times.blueDawnEnd}-${d.sun.times.goldenDawnEnd}`,
          goldenHourEvening: d.sun.polar ? null : `${d.sun.times.goldenDuskStart}-${d.sun.times.blueDuskStart}`,
          blueHourMorning: d.sun.polar ? null : `${d.sun.times.civilDawn}-${d.sun.times.blueDawnEnd}`,
          blueHourEvening: d.sun.polar ? null : `${d.sun.times.blueDuskStart}-${d.sun.times.civilDusk}`,
          dayLength: d.sun.dayLength,
        }
      : { unavailable: d.reason },
  };
}

// ─── the plugin ─────────────────────────────────────────────────────────────

module.exports = definePlugin({
  async onLoad(ctx) {
    for (const [id, sql] of MIGRATIONS) await ctx.db.migrate(id, sql);
    ctx.log.info('sundial ready');
  },

  routes: [
    {
      // GET /trip?tripId=N — the whole model for the trip tab (with forecast sky).
      method: 'GET', path: '/trip', auth: true,
      async handler(req, ctx) {
        const tripId = intOf(req.query.tripId);
        if (!tripId) return json(400, { error: 'tripId required' });
        try {
          const model = await loadTrip(ctx, tripId, { weather: true });
          return model ? json(200, model) : json(404, { error: 'trip not found' });
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      // POST /shoot-day { tripId, dayId, on, note? } — mark a day for photography.
      method: 'POST', path: '/shoot-day', auth: true,
      async handler(req, ctx) {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const tripId = intOf(b.tripId);
        const dayId = intOf(b.dayId);
        if (!tripId || !dayId) return json(400, { error: 'tripId and dayId required' });
        try {
          return json(200, await setShootDay(ctx, { tripId, dayId, on: !!b.on, note: b.note, userId: req.user ? req.user.id : null }));
        } catch (e) {
          return fail(e);
        }
      },
    },
    {
      // POST /zone { tripId, zone } — pin the trip's time zone ("" clears it → automatic).
      method: 'POST', path: '/zone', auth: true,
      async handler(req, ctx) {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const tripId = intOf(b.tripId);
        if (!tripId) return json(400, { error: 'tripId required' });
        try {
          return json(200, await setZone(ctx, { tripId, zone: b.zone, userId: req.user ? req.user.id : null }));
        } catch (e) {
          return fail(e);
        }
      },
    },
  ],

  hooks: {
    // Rows under each day in the planner: sunrise + golden hour at the top, golden hour + sunset at the foot.
    dayScheduleProvider: {
      async getSchedule(tripId, ctx) {
        const model = await loadTrip(ctx, tripId);
        return model ? scheduleRows(model) : [];
      },
    },

    // Shoot days get a gold wash on their day card — reads own data only, so it is cheap.
    dayTintProvider: {
      async getDayTints(tripId, ctx) {
        const rows = await readShootDays(ctx, tripId);
        return rows.map((r) => ({
          dayId: r.day_id,
          badgeColor: SHOOT_COLOR,
          headerColor: SHOOT_COLOR,
          label: r.note ? `Shoot day: ${r.note}`.slice(0, 60) : 'Shoot day',
        }));
      },
    },

    // The place panel: sun times at this exact spot on the day it is planned for.
    placeDetailProvider: {
      async getDetails(placeId, ctx) {
        const rows = await ctx.db.query('SELECT trip_id, day_id, date, zone, lat, lng FROM place_index WHERE place_id = ?', placeId);
        const p = rows[0];
        if (!p || !p.date || !p.zone) return [];
        const { goldenAltitude, clock } = await userSettings(ctx);
        let s;
        try {
          s = sun.sunTimes({ date: p.date, lat: p.lat, lng: p.lng, zone: p.zone, goldenAltitude });
        } catch {
          return [];
        }
        const t = (k) => sun.formatTime(s.events[k], s.zone, clock);
        if (s.polar === 'day') return [{ label: 'Sun', value: `Midnight sun on ${p.date}` }];
        if (s.polar === 'night') return [{ label: 'Sun', value: `Polar night on ${p.date}` }];
        return [
          { label: 'Sunrise', value: `${t('sunrise')} (${p.date})` },
          { label: 'Golden hour', value: `${t('blueDawnEnd')} to ${t('goldenDawnEnd')} and ${t('goldenDuskStart')} to ${t('blueDuskStart')}` },
          { label: 'Blue hour', value: `${t('civilDawn')} to ${t('blueDawnEnd')} and ${t('blueDuskStart')} to ${t('civilDusk')}` },
          { label: 'Sunset', value: t('sunset') },
        ];
      },
    },

    // Stops timed before sunrise or after sunset, and shoot days with nowhere to compute from.
    warningProvider: {
      async getWarnings(tripId, ctx) {
        const model = await loadTrip(ctx, tripId);
        return model ? warningsFor(model) : [];
      },
    },

    // A "Sun and light" table in the exported PDF.
    pdfSectionProvider: {
      async getSections(tripId, ctx) {
        const model = await loadTrip(ctx, tripId);
        return model ? pdfSections(model) : [];
      },
    },

    // Dashboard badge: how many shoot days a trip has. Own data only — no core reads per card.
    tripCardProvider: {
      async getCards(tripIds, ctx) {
        const ids = (Array.isArray(tripIds) ? tripIds : []).map(intOf).filter(Boolean).slice(0, 60);
        if (!ids.length) return [];
        const rows = await ctx.db.query(
          `SELECT trip_id, COUNT(*) AS n FROM shoot_days WHERE trip_id IN (${ids.map(() => '?').join(',')}) GROUP BY trip_id`,
          ...ids,
        );
        return rows.map((r) => ({
          tripId: r.trip_id,
          id: 'shoot-days',
          label: Number(r.n) === 1 ? 'Shoot day' : 'Shoot days',
          value: String(r.n),
          icon: 'Camera',
          tone: 'default',
        }));
      },
    },

    // MCP: the same facts for an assistant connected to TREK, as the requesting user.
    mcpToolProvider: {
      tools: ['sun_times', 'list_shoot_days', 'mark_shoot_day'],
      async callTool({ name, args }, ctx) {
        const a = args && typeof args === 'object' ? args : {};
        if (name === 'sun_times') {
          const tripId = intOf(a.tripId);
          if (tripId) {
            const model = await loadTrip(ctx, tripId, { index: false });
            if (!model) throw new Error('trip not found');
            const dayId = intOf(a.dayId);
            if (dayId) {
              const d = model.days.find((x) => x.id === dayId);
              if (!d) throw new Error('dayId does not belong to this trip');
              return compactDay(d);
            }
            return { trip: model.trip, zone: model.zone, summary: model.summary, days: model.days.map(compactDay) };
          }
          const lat = Number(a.lat);
          const lng = Number(a.lng);
          const date = typeof a.date === 'string' ? a.date : isoToday();
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('pass tripId, or date with lat and lng');
          const zone = typeof a.zone === 'string' && a.zone ? a.zone : sun.zoneFromLongitude(lng);
          const { goldenAltitude, clock } = await userSettings(ctx);
          const s = sun.sunTimes({ date, lat, lng, zone, goldenAltitude });
          const t = (k) => sun.formatTime(s.events[k], zone, clock);
          return {
            date, zone, polar: s.polar, dayLength: sun.formatDuration(s.dayLengthMinutes),
            astronomicalDawn: t('astroDawn'), blueHourMorning: `${t('civilDawn')}-${t('blueDawnEnd')}`, sunrise: t('sunrise'),
            goldenHourMorning: `${t('blueDawnEnd')}-${t('goldenDawnEnd')}`, solarNoon: t('noon'),
            goldenHourEvening: `${t('goldenDuskStart')}-${t('blueDuskStart')}`, sunset: t('sunset'),
            blueHourEvening: `${t('blueDuskStart')}-${t('civilDusk')}`, astronomicalDusk: t('astroDusk'),
          };
        }
        if (name === 'list_shoot_days') {
          const tripId = intOf(a.tripId);
          if (!tripId) throw new Error('tripId required');
          const model = await loadTrip(ctx, tripId, { index: false });
          if (!model) throw new Error('trip not found');
          return { tripId, shootDays: model.days.filter((d) => d.shoot.on).map(compactDay) };
        }
        if (name === 'mark_shoot_day') {
          const tripId = intOf(a.tripId);
          const dayId = intOf(a.dayId);
          if (!tripId || !dayId) throw new Error('tripId and dayId required');
          // The MCP session has no user id we can read; the mark is stored without an author.
          return setShootDay(ctx, { tripId, dayId, on: a.on !== false, note: a.note, userId: null });
        }
        throw new Error(`unknown tool ${name}`);
      },
    },
  },

  // Housekeeping on core deletions — runs userless, so only own data is touched.
  events: [
    {
      on: 'day:deleted',
      async handler({ tripId, entityId }, ctx) {
        if (!intOf(entityId)) return;
        await ctx.db.exec('DELETE FROM shoot_days WHERE day_id = ?' + (intOf(tripId) ? ' AND trip_id = ?' : ''), ...[entityId, intOf(tripId)].filter(Boolean));
        await ctx.db.exec('UPDATE place_index SET day_id = NULL WHERE day_id = ?', entityId);
      },
    },
    {
      on: 'trip:deleted',
      async handler({ tripId }, ctx) {
        if (!intOf(tripId)) return;
        await ctx.db.tx([
          { sql: 'DELETE FROM shoot_days WHERE trip_id = ?', args: [tripId] },
          { sql: 'DELETE FROM trip_prefs WHERE trip_id = ?', args: [tripId] },
          { sql: 'DELETE FROM place_index WHERE trip_id = ?', args: [tripId] },
        ]);
      },
    },
  ],

  // GDPR. Marks are shared trip data, so erasure detaches the author rather than
  // deleting the group's plan; export returns exactly what carries the user's id.
  async deleteUserData({ userId }, ctx) {
    await ctx.db.tx([
      { sql: 'UPDATE shoot_days SET user_id = NULL WHERE user_id = ?', args: [userId] },
      { sql: 'UPDATE trip_prefs SET updated_by = NULL WHERE updated_by = ?', args: [userId] },
    ]);
  },
  async exportUserData({ userId }, ctx) {
    const [shootDays, zones] = await Promise.all([
      ctx.db.query('SELECT trip_id, day_id, note, created_at FROM shoot_days WHERE user_id = ?', userId),
      ctx.db.query('SELECT trip_id, zone, updated_at FROM trip_prefs WHERE updated_by = ?', userId),
    ]);
    return { shootDays, tripZones: zones };
  },
});

// Exposed for tests; the host reads only the definition above.
module.exports.__internals = { loadTrip, setShootDay, setZone, scheduleRows, warningsFor, pdfSections, compactDay, lightAt };
