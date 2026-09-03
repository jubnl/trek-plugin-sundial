// Solar engine tests — reference values from published almanac tables (timeanddate /
// NOAA solar calculator), asserted to a ±3-minute tolerance, which is the accuracy
// class of the NOAA algorithm once refraction and the solar radius are included.
const test = require('node:test');
const assert = require('node:assert/strict');
const sun = require('../server/sun.js');

const TOKYO = { lat: 35.6762, lng: 139.6503, zone: 'Asia/Tokyo' };
const LONDON = { lat: 51.5074, lng: -0.1278, zone: 'Europe/London' };
const HONOLULU = { lat: 21.3069, lng: -157.8583, zone: 'Pacific/Honolulu' };
const TROMSO = { lat: 69.6496, lng: 18.956, zone: 'Europe/Oslo' };
const QUITO = { lat: -0.1807, lng: -78.4678, zone: 'America/Guayaquil' };

function hhmm(ms, zone) {
  return sun.formatTime(ms, zone, '24h');
}

function minutesOf(text) {
  return sun.parseClock(text);
}

function within(actual, expected, tolerance = 3) {
  const a = minutesOf(actual);
  const e = minutesOf(expected);
  assert.ok(a !== null && e !== null, `unparseable ${actual} / ${expected}`);
  assert.ok(Math.abs(a - e) <= tolerance, `${actual} not within ${tolerance} min of ${expected}`);
}

test('Tokyo, 1 August 2026 — sunrise 04:48, sunset 18:45 JST', () => {
  const r = sun.sunTimes({ date: '2026-08-01', ...TOKYO });
  within(hhmm(r.events.sunrise, TOKYO.zone), '04:48');
  within(hhmm(r.events.sunset, TOKYO.zone), '18:45');
  assert.equal(r.offsetMinutes, 540);
  assert.equal(r.polar, null);
  assert.ok(r.dayLengthMinutes > 13 * 60 && r.dayLengthMinutes < 14.2 * 60);
});

test('London, 21 June 2026 — sunrise 04:43, sunset 21:21 BST (DST offset honoured)', () => {
  const r = sun.sunTimes({ date: '2026-06-21', ...LONDON });
  within(hhmm(r.events.sunrise, LONDON.zone), '04:43');
  within(hhmm(r.events.sunset, LONDON.zone), '21:21');
  assert.equal(r.offsetMinutes, 60);
});

test('London, 21 December 2026 — sunrise 08:04, sunset 15:53 GMT', () => {
  const r = sun.sunTimes({ date: '2026-12-21', ...LONDON });
  within(hhmm(r.events.sunrise, LONDON.zone), '08:04');
  within(hhmm(r.events.sunset, LONDON.zone), '15:53');
  assert.equal(r.offsetMinutes, 0);
});

test('Honolulu, 15 March 2026 — a west-of-Greenwich date-line-safe case', () => {
  const r = sun.sunTimes({ date: '2026-03-15', ...HONOLULU });
  within(hhmm(r.events.sunrise, HONOLULU.zone), '06:41');
  within(hhmm(r.events.sunset, HONOLULU.zone), '18:44');
});

test('Quito on the equinox — about a 12-hour day', () => {
  const r = sun.sunTimes({ date: '2026-03-20', ...QUITO });
  assert.ok(Math.abs(r.dayLengthMinutes - 727) <= 4, `day length ${r.dayLengthMinutes}`);
});

test('Tromsø midsummer is polar day: no sunrise, 24h of daylight, still a civil-dusk value of null', () => {
  const r = sun.sunTimes({ date: '2026-06-21', ...TROMSO });
  assert.equal(r.polar, 'day');
  assert.equal(r.events.sunrise, null);
  assert.equal(r.events.sunset, null);
  assert.equal(r.dayLengthMinutes, 1440);
  assert.equal(r.events.civilDusk, null);
});

test('Tromsø midwinter is polar night, yet civil twilight still happens around noon', () => {
  const r = sun.sunTimes({ date: '2026-12-21', ...TROMSO });
  assert.equal(r.polar, 'night');
  assert.equal(r.dayLengthMinutes, 0);
  assert.ok(r.events.civilDawn !== null, 'civil dawn exists at 69.6N in December');
  assert.ok(r.events.civilDusk !== null);
});

test('event order is monotonic on an ordinary day', () => {
  const r = sun.sunTimes({ date: '2026-08-01', ...TOKYO });
  const order = [
    'astroDawn', 'nauticalDawn', 'civilDawn', 'blueDawnEnd', 'sunrise', 'goldenDawnEnd', 'noon',
    'goldenDuskStart', 'sunset', 'blueDuskStart', 'civilDusk', 'nauticalDusk', 'astroDusk',
  ];
  for (let i = 1; i < order.length; i++) {
    assert.ok(r.events[order[i - 1]] < r.events[order[i]], `${order[i - 1]} < ${order[i]}`);
  }
});

test('golden altitude setting widens the golden hour and is clamped', () => {
  const six = sun.sunTimes({ date: '2026-08-01', ...TOKYO, goldenAltitude: 6 });
  const ten = sun.sunTimes({ date: '2026-08-01', ...TOKYO, goldenAltitude: 10 });
  assert.ok(ten.events.goldenDawnEnd > six.events.goldenDawnEnd);
  assert.equal(sun.clampGolden('nonsense'), 6);
  assert.equal(sun.clampGolden(99), 15);
  assert.equal(sun.clampGolden(1), 2);
});

test('formatting: 12h clock, durations, local minutes', () => {
  const r = sun.sunTimes({ date: '2026-08-01', ...TOKYO });
  assert.match(sun.formatTime(r.events.sunset, TOKYO.zone, '12h'), /^6:4\dpm$/);
  assert.equal(sun.formatDuration(65), '1h 05m');
  const m = sun.localMinutes(r.events.sunrise, '2026-08-01', TOKYO.zone);
  assert.ok(m > 4 * 60 && m < 5 * 60, `sunrise at ${m} local minutes`);
});

test('zone helpers: validation and longitude fallback', () => {
  assert.equal(sun.isValidZone('Asia/Tokyo'), true);
  assert.equal(sun.isValidZone('Mars/Olympus'), false);
  assert.equal(sun.isValidZone(''), false);
  assert.equal(sun.zoneFromLongitude(139.65), 'Etc/GMT-9');
  assert.equal(sun.zoneFromLongitude(-157.86), 'Etc/GMT+11');
  assert.equal(sun.zoneFromLongitude(3), 'Etc/UTC');
  assert.equal(sun.isValidZone(sun.zoneFromLongitude(139.65)), true);
  assert.equal(sun.zoneOffsetMinutes('Etc/GMT-9', Date.UTC(2026, 7, 1)), 540);
});

test('input validation rejects bad dates, coordinates and zones', () => {
  assert.throws(() => sun.sunTimes({ date: 'yesterday', ...TOKYO }), /YYYY-MM-DD/);
  assert.throws(() => sun.sunTimes({ date: '2026-08-01', lat: 95, lng: 0, zone: 'UTC' }), /lat/);
  assert.throws(() => sun.sunTimes({ date: '2026-08-01', lat: 0, lng: 200, zone: 'UTC' }), /lng/);
  assert.throws(() => sun.sunTimes({ date: '2026-08-01', lat: 0, lng: 0, zone: 'Nope/Nope' }), /time zone/);
});
