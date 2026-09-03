// Solar engine — NOAA's solar-position algorithm (Meeus), dependency-free.
//
// Everything here is pure: no ctx, no I/O. Times are computed in UTC as Date objects
// and rendered into a named IANA zone with Intl, so the same engine serves the route
// handlers, the provider hooks and the MCP tools identically.
//
// Altitude thresholds (degrees of the sun's centre above the horizon):
//   -18  astronomical twilight begins/ends
//   -12  nautical twilight
//    -6  civil twilight
//    -4  blue hour ends (morning) / begins (evening)
//    -0.833  sunrise / sunset (refraction + solar radius)
//    +6  golden hour ends (morning) / begins (evening) — the upper bound is a user setting
'use strict';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const MS_PER_DAY = 86400000;

const ALT = Object.freeze({
  astro: -18,
  nautical: -12,
  civil: -6,
  blue: -4,
  horizon: -0.833,
});

/** Julian day for a UTC instant (ms since epoch). */
function julianDay(ms) {
  return ms / MS_PER_DAY + 2440587.5;
}

/** Julian century since J2000 for a Julian day. */
function julianCentury(jd) {
  return (jd - 2451545) / 36525;
}

/** Declination (deg) and equation of time (minutes) for a Julian century. */
function solarPosition(T) {
  const L0 = mod360(280.46646 + T * (36000.76983 + T * 0.0003032));
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = M * RAD;
  const C =
    Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mr) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const apparentLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const declination = Math.asin(Math.sin(eps * RAD) * Math.sin(apparentLong * RAD)) * DEG;
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const L0r = L0 * RAD;
  const eot =
    4 *
    DEG *
    (y * Math.sin(2 * L0r) -
      2 * e * Math.sin(Mr) +
      4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
      0.5 * y * y * Math.sin(4 * L0r) -
      1.25 * e * e * Math.sin(2 * Mr));
  return { declination, eot };
}

function mod360(x) {
  return ((x % 360) + 360) % 360;
}

/**
 * Hour angle (deg) at which the sun's centre sits at `altitude` for a latitude and
 * declination. Returns null when the sun never reaches that altitude on this day
 * (polar day/night for that threshold), tagged with which side it stays on.
 */
function hourAngle(lat, declination, altitude) {
  const cosHA =
    (Math.sin(altitude * RAD) - Math.sin(lat * RAD) * Math.sin(declination * RAD)) /
    (Math.cos(lat * RAD) * Math.cos(declination * RAD));
  if (cosHA > 1) return { ha: null, always: 'below' };
  if (cosHA < -1) return { ha: null, always: 'above' };
  return { ha: Math.acos(cosHA) * DEG, always: null };
}

/**
 * UTC offset (minutes east of UTC) of an IANA zone at a UTC instant. Throws on an
 * unknown zone — callers validate with `isValidZone` first.
 */
function zoneOffsetMinutes(zone, ms) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - ms) / 60000);
}

function isValidZone(zone) {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A rough zone for a longitude when nobody has set one: Etc/GMT-9 means UTC+9. */
function zoneFromLongitude(lng) {
  const hours = Math.max(-12, Math.min(14, Math.round(lng / 15)));
  if (hours === 0) return 'Etc/UTC';
  // The Etc/GMT sign is inverted by POSIX convention.
  return hours > 0 ? `Etc/GMT-${hours}` : `Etc/GMT+${-hours}`;
}

/**
 * Solar noon (UTC ms) nearest to local noon of `date` in `zone` at longitude `lng`,
 * and the solar position at that instant — the anchor every other event hangs off.
 */
function solarNoon(date, lng, zone) {
  const [y, m, d] = date.split('-').map(Number);
  const localNoonGuess = Date.UTC(y, m - 1, d, 12, 0, 0);
  const offset = zoneOffsetMinutes(zone, localNoonGuess);
  const localNoonUtc = localNoonGuess - offset * 60000;
  // Two passes: the equation of time at the corrected noon refines the noon itself.
  let noon = localNoonUtc;
  for (let i = 0; i < 2; i++) {
    const { eot } = solarPosition(julianCentury(julianDay(noon)));
    const dayStart = Math.floor(localNoonUtc / MS_PER_DAY) * MS_PER_DAY;
    // Solar noon in UTC minutes past the UTC midnight that precedes local noon.
    let noonMin = 720 - 4 * lng - eot;
    let candidate = dayStart + noonMin * 60000;
    // Keep the candidate within half a day of local noon (date-line safety).
    while (candidate - localNoonUtc > MS_PER_DAY / 2) candidate -= MS_PER_DAY;
    while (localNoonUtc - candidate > MS_PER_DAY / 2) candidate += MS_PER_DAY;
    noon = candidate;
  }
  return { noon, offset };
}

/** The UTC instant at which the sun crosses `altitude` before (rising) or after (setting) noon. */
function crossing(noon, lat, altitude, rising) {
  // Iterate: the declination at the crossing differs slightly from the one at noon.
  let t = noon;
  let result = null;
  for (let i = 0; i < 2; i++) {
    const { declination } = solarPosition(julianCentury(julianDay(t)));
    const { ha, always } = hourAngle(lat, declination, altitude);
    if (ha === null) return { at: null, always };
    t = noon + (rising ? -1 : 1) * ha * 4 * 60000;
    result = { at: t, always: null };
  }
  return result;
}

/**
 * Compute the full set of sun events for one local date at one location.
 *
 * @param {{date:string, lat:number, lng:number, zone:string, goldenAltitude?:number}} input
 * @returns {{
 *   date:string, zone:string, offsetMinutes:number, noon:number,
 *   events: Record<string, number|null>,
 *   polar: 'day'|'night'|null,
 *   dayLengthMinutes:number|null,
 *   goldenAltitude:number
 * }}
 */
function sunTimes(input) {
  const { date, lat, lng, zone } = input;
  const goldenAltitude = clampGolden(input.goldenAltitude);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('date must be YYYY-MM-DD');
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error('lat out of range');
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new Error('lng out of range');
  if (!isValidZone(zone)) throw new Error(`unknown time zone "${zone}"`);

  const { noon, offset } = solarNoon(date, lng, zone);

  const rise = (alt) => crossing(noon, lat, alt, true);
  const set = (alt) => crossing(noon, lat, alt, false);

  const sunrise = rise(ALT.horizon);
  const sunset = set(ALT.horizon);

  const events = {
    astroDawn: rise(ALT.astro).at,
    nauticalDawn: rise(ALT.nautical).at,
    civilDawn: rise(ALT.civil).at,
    blueDawnEnd: rise(ALT.blue).at,
    sunrise: sunrise.at,
    goldenDawnEnd: rise(goldenAltitude).at,
    noon,
    goldenDuskStart: set(goldenAltitude).at,
    sunset: sunset.at,
    blueDuskStart: set(ALT.blue).at,
    civilDusk: set(ALT.civil).at,
    nauticalDusk: set(ALT.nautical).at,
    astroDusk: set(ALT.astro).at,
  };

  let polar = null;
  if (sunrise.at === null) polar = sunrise.always === 'above' ? 'day' : 'night';

  const dayLengthMinutes =
    events.sunrise !== null && events.sunset !== null
      ? Math.round((events.sunset - events.sunrise) / 60000)
      : polar === 'day'
        ? 1440
        : polar === 'night'
          ? 0
          : null;

  return { date, zone, offsetMinutes: offset, noon, events, polar, dayLengthMinutes, goldenAltitude };
}

function clampGolden(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 6;
  return Math.max(2, Math.min(15, n));
}

/** Format a UTC instant as a wall-clock time in `zone`. `clock` is '24h' or '12h'. */
function formatTime(ms, zone, clock) {
  if (ms === null || ms === undefined) return null;
  const twelve = clock === '12h';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: twelve ? 'numeric' : '2-digit',
    minute: '2-digit',
    hour12: twelve,
    hourCycle: twelve ? undefined : 'h23',
  })
    .format(new Date(ms))
    .toLowerCase()
    .replace(/\s/g, '');
}

/** Minutes past local midnight of `date` in `zone` for a UTC instant (may exceed 1440 or be negative). */
function localMinutes(ms, date, zone) {
  if (ms === null || ms === undefined) return null;
  const [y, m, d] = date.split('-').map(Number);
  const offset = zoneOffsetMinutes(zone, ms);
  const localMidnight = Date.UTC(y, m - 1, d) - offset * 60000;
  return (ms - localMidnight) / 60000;
}

/** "HH:MM" wall-clock text → minutes past midnight, or null. Accepts "H:MM" and seconds. */
function parseClock(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function formatDuration(minutes) {
  if (minutes === null || minutes === undefined) return null;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

module.exports = {
  ALT,
  sunTimes,
  formatTime,
  formatDuration,
  localMinutes,
  parseClock,
  isValidZone,
  zoneFromLongitude,
  zoneOffsetMinutes,
  clampGolden,
};
