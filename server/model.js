// Trip model — turns TREK's day/accommodation/place rows into "where are we each day"
// and runs the solar engine over it. Pure: takes plain rows, returns plain objects.
// The ctx-reading half lives in index.js so this file is trivially unit-testable.
'use strict';

const sun = require('./sun.js');
const { zoneFromLocation } = require('./zones.js');

const EVENT_KEYS = [
  'astroDawn', 'nauticalDawn', 'civilDawn', 'blueDawnEnd', 'sunrise', 'goldenDawnEnd', 'noon',
  'goldenDuskStart', 'sunset', 'blueDuskStart', 'civilDusk', 'nauticalDusk', 'astroDusk',
];

function num(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

function located(lat, lng) {
  const la = num(lat);
  const ln = num(lng);
  return la !== null && ln !== null && Math.abs(la) <= 90 && Math.abs(ln) <= 180 ? { lat: la, lng: ln } : null;
}

/** ISO date of day N of a trip when the row itself has no date. */
function dateFor(day, trip) {
  if (typeof day.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(day.date)) return day.date.slice(0, 10);
  const start = typeof trip?.start_date === 'string' ? trip.start_date.slice(0, 10) : null;
  const n = Number(day.day_number);
  if (!start || !Number.isInteger(n)) return null;
  const [y, m, d] = start.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n - 1)).toISOString().slice(0, 10);
}

/**
 * Where each day's sun is computed from. Priority per day:
 *   stop  — the first located stop of the day, in itinerary order
 *   stay  — an accommodation whose day range covers the day
 *   carry — the previous resolved day (you rarely teleport overnight)
 *   next  — the next resolved day, for a leading run of empty days
 *   pool  — the oldest located place in the trip's place pool
 */
function resolveAnchors(days, accommodations, places) {
  const index = new Map(days.map((d, i) => [d.id, i]));
  const anchors = new Array(days.length).fill(null);

  days.forEach((day, i) => {
    for (const a of Array.isArray(day.assignments) ? day.assignments : []) {
      const p = a.place || {};
      const pos = located(p.lat, p.lng);
      if (pos) {
        anchors[i] = { ...pos, name: String(p.name || 'Stop'), source: 'stop', placeId: p.id ?? a.place_id ?? null };
        break;
      }
    }
  });

  for (const acc of Array.isArray(accommodations) ? accommodations : []) {
    const pos = located(acc.place_lat ?? acc.lat, acc.place_lng ?? acc.lng);
    const from = index.get(acc.start_day_id);
    const to = index.get(acc.end_day_id);
    if (!pos || from === undefined || to === undefined) continue;
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
      if (!anchors[i]) anchors[i] = { ...pos, name: String(acc.place_name || acc.name || 'Stay'), source: 'stay', placeId: acc.place_id ?? null };
    }
  }

  for (let i = 1; i < anchors.length; i++) {
    if (!anchors[i] && anchors[i - 1]) anchors[i] = { ...anchors[i - 1], source: 'carry' };
  }
  for (let i = anchors.length - 2; i >= 0; i--) {
    if (!anchors[i] && anchors[i + 1]) anchors[i] = { ...anchors[i + 1], source: 'next' };
  }

  if (anchors.some((a) => !a)) {
    // getPlaces returns created_at DESC — the last row is the oldest, the trip's first idea.
    const pool = (Array.isArray(places) ? [...places].reverse() : []).find((p) => located(p.lat, p.lng));
    if (pool) {
      const pos = located(pool.lat, pool.lng);
      anchors.forEach((a, i) => {
        if (!a) anchors[i] = { ...pos, name: String(pool.name || 'Place'), source: 'pool', placeId: pool.id ?? null };
      });
    }
  }
  return anchors;
}

function stopsOf(day) {
  const out = [];
  for (const a of Array.isArray(day.assignments) ? day.assignments : []) {
    const p = a.place || {};
    const time = a.assignment_time || p.place_time || null;
    out.push({
      assignmentId: a.id ?? null,
      placeId: p.id ?? a.place_id ?? null,
      name: String(p.name || 'Stop'),
      time: typeof time === 'string' ? time.slice(0, 5) : null,
      minutes: sun.parseClock(typeof time === 'string' ? time : null),
      located: !!located(p.lat, p.lng),
      lat: num(p.lat),
      lng: num(p.lng),
    });
  }
  return out;
}

/**
 * Build the per-day model.
 * @param {{
 *   trip: object, days: object[], accommodations?: object[], places?: object[],
 *   zone?: string|null, zoneSource?: 'user'|'request',
 *   shootDays?: Array<{day_id:number, note?:string|null, user_id?:number|null}>,
 *   goldenAltitude?: number, clock?: '24h'|'12h'
 * }} input
 */
function buildTripModel(input) {
  const trip = input.trip || {};
  const days = [...(Array.isArray(input.days) ? input.days : [])].sort(
    (a, b) => (Number(a.day_number) || 0) - (Number(b.day_number) || 0),
  );
  const anchors = resolveAnchors(days, input.accommodations, input.places);
  const userZone = input.zone && sun.isValidZone(input.zone) ? input.zone : null;
  const zoneSource = userZone ? (input.zoneSource === 'request' ? 'request' : 'user') : 'auto';
  const golden = sun.clampGolden(input.goldenAltitude);
  const clock = input.clock === '12h' ? '12h' : '24h';
  const marks = new Map((input.shootDays || []).map((s) => [Number(s.day_id), s]));

  const out = days.map((day, i) => {
    const anchor = anchors[i];
    const date = dateFor(day, trip);
    const estimate = anchor ? zoneFromLocation(anchor.lat, anchor.lng) : null;
    const zoneAuto = estimate ? estimate.zone : null;
    const zone = userZone || zoneAuto;
    const zoneMethod = userZone ? zoneSource : estimate ? estimate.method : null;
    let solar = null;
    let reason = null;
    if (!date) reason = 'no-date';
    else if (!anchor) reason = 'no-location';
    else {
      try {
        solar = sun.sunTimes({ date, lat: anchor.lat, lng: anchor.lng, zone, goldenAltitude: golden });
      } catch (e) {
        reason = 'error';
      }
    }
    const mark = marks.get(Number(day.id));
    // A pinned zone is one zone for the whole trip. When a day's location sits far
    // from it (Zurich pinned, a day in Tokyo), the wall clock is still Zurich's, so
    // say so rather than quietly reporting a sunrise at 22:15.
    let zoneMismatch = null;
    if (solar && userZone && anchor) {
      const estimated = sun.zoneOffsetMinutes(zoneAuto, solar.noon);
      if (Math.abs(solar.offsetMinutes - estimated) >= 90) {
        zoneMismatch = { pinned: userZone, pinnedOffset: solar.offsetMinutes, estimatedZone: zoneAuto, estimatedOffset: estimated };
      }
    }
    return {
      id: day.id,
      number: Number(day.day_number) || i + 1,
      date,
      title: day.title || null,
      anchor,
      zone,
      zoneMethod,
      zoneMismatch,
      stops: stopsOf(day),
      sun: solar ? present(solar, clock) : null,
      reason,
      shoot: mark ? { on: true, note: mark.note || null, userId: mark.user_id ?? null } : { on: false, note: null, userId: null },
    };
  });

  return {
    trip: { id: trip.id, title: trip.title || null, start: trip.start_date || null, end: trip.end_date || null },
    zone: { name: userZone, source: zoneSource },
    settings: { goldenAltitude: golden, clock },
    days: out,
    summary: summarize(out),
  };
}

/** Wall-clock strings + local-minute offsets for the UI bar, from a raw engine result. */
function present(solar, clock) {
  const times = {};
  const minutes = {};
  for (const k of EVENT_KEYS) {
    times[k] = sun.formatTime(solar.events[k], solar.zone, clock);
    minutes[k] = solar.events[k] === null ? null : Math.round(sun.localMinutes(solar.events[k], solar.date, solar.zone));
  }
  return {
    zone: solar.zone,
    offsetMinutes: solar.offsetMinutes,
    polar: solar.polar,
    dayLengthMinutes: solar.dayLengthMinutes,
    dayLength: sun.formatDuration(solar.dayLengthMinutes),
    goldenAltitude: solar.goldenAltitude,
    times,
    minutes,
    iso: Object.fromEntries(EVENT_KEYS.map((k) => [k, solar.events[k] === null ? null : new Date(solar.events[k]).toISOString()])),
  };
}

function summarize(days) {
  const lit = days.filter((d) => d.sun && d.sun.polar === null);
  const pick = (fn) => (lit.length ? lit.reduce((best, d) => (fn(d, best) ? d : best)) : null);
  const earliest = pick((d, b) => d.sun.minutes.sunrise < b.sun.minutes.sunrise);
  const latest = pick((d, b) => d.sun.minutes.sunset > b.sun.minutes.sunset);
  const longest = pick((d, b) => d.sun.dayLengthMinutes > b.sun.dayLengthMinutes);
  const shortest = pick((d, b) => d.sun.dayLengthMinutes < b.sun.dayLengthMinutes);
  return {
    computed: days.filter((d) => d.sun).length,
    total: days.length,
    shootDays: days.filter((d) => d.shoot.on).length,
    earliestSunrise: earliest ? { day: earliest.number, time: earliest.sun.times.sunrise } : null,
    latestSunset: latest ? { day: latest.number, time: latest.sun.times.sunset } : null,
    longestDay: longest ? { day: longest.number, length: longest.sun.dayLength } : null,
    shortestDay: shortest ? { day: shortest.number, length: shortest.sun.dayLength } : null,
    polarDays: days.filter((d) => d.sun && d.sun.polar === 'day').length,
    polarNights: days.filter((d) => d.sun && d.sun.polar === 'night').length,
    zoneMismatches: days.filter((d) => d.zoneMismatch).length,
  };
}

/**
 * The day as painted segments, in paint order (later entries cover earlier ones).
 * A missing boundary means the sun never crossed that altitude: on a non-polar
 * day the phase then simply extends to the edge of the day, which is exactly what
 * the bar should show — and what a stop at that minute should be classified as.
 * The client keeps a verbatim copy for the bar.
 */
function segments(s) {
  const W = 1440;
  const m = s.minutes;
  const lo = (v) => (v === null || v === undefined ? 0 : v);
  const hi = (v) => (v === null || v === undefined ? W : v);
  const out = [{ a: 0, b: W, kind: 'night' }];
  if (s.polar === 'day') return out.concat([{ a: 0, b: W, kind: 'day' }]);
  if (s.polar === 'night') {
    if (m.astroDawn !== null) out.push({ a: m.astroDawn, b: m.astroDusk, kind: 'astro' });
    if (m.nauticalDawn !== null) out.push({ a: m.nauticalDawn, b: m.nauticalDusk, kind: 'nautical' });
    if (m.civilDawn !== null) out.push({ a: m.civilDawn, b: m.civilDusk, kind: 'blue' });
    return out;
  }
  out.push({ a: lo(m.astroDawn), b: hi(m.astroDusk), kind: 'astro' });
  out.push({ a: lo(m.nauticalDawn), b: hi(m.nauticalDusk), kind: 'nautical' });
  out.push({ a: lo(m.civilDawn), b: hi(m.civilDusk), kind: 'blue' });
  out.push({ a: lo(m.blueDawnEnd), b: hi(m.blueDuskStart), kind: 'golden' });
  if (m.goldenDawnEnd !== null && m.goldenDuskStart !== null) out.push({ a: m.goldenDawnEnd, b: m.goldenDuskStart, kind: 'day' });
  return out;
}

/** A stop's relation to the light: 'golden' | 'blue' | 'day' | 'dark' | null (no time / no sun). */
function lightAt(minutes, s) {
  if (minutes === null || minutes === undefined || !s) return null;
  let kind = 'night';
  for (const seg of segments(s)) if (minutes >= seg.a && minutes <= seg.b) kind = seg.kind;
  return kind === 'golden' || kind === 'blue' || kind === 'day' ? kind : 'dark';
}

module.exports = { buildTripModel, resolveAnchors, dateFor, lightAt, segments, present, EVENT_KEYS };
