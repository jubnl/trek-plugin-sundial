// The region table: every zone must be one Intl knows, and the places people
// actually travel to must land on the right offset even where longitude lies.
const test = require('node:test');
const assert = require('node:assert/strict');
const { zoneFromLocation, BOXES } = require('../server/zones.js');
const sun = require('../server/sun.js');

test('every box names a zone Intl accepts and has a sane extent', () => {
  for (const [zone, latMin, latMax, lngMin, lngMax] of BOXES) {
    assert.ok(sun.isValidZone(zone), `unknown zone ${zone}`);
    assert.ok(latMin < latMax && lngMin < lngMax, `bad box for ${zone}`);
  }
});

const CASES = [
  ['Lyon', 45.764, 4.8357, 'Europe/Paris'],
  ['Madrid', 40.4168, -3.7038, 'Europe/Madrid'],
  ['Amsterdam', 52.3676, 4.9041, 'Europe/Berlin'],
  ['Oslo', 59.9139, 10.7522, 'Europe/Berlin'],
  ['Tromsø', 69.6496, 18.956, 'Europe/Oslo'],
  ['Svalbard', 78.2232, 15.6267, 'Arctic/Longyearbyen'],
  ['London', 51.5074, -0.1278, 'Europe/London'],
  ['Brighton', 50.8225, -0.1372, 'Europe/London'],
  ['Lisbon', 38.7223, -9.1393, 'Europe/Lisbon'],
  ['Helsinki', 60.1699, 24.9384, 'Europe/Helsinki'],
  ['Athens', 37.9838, 23.7275, 'Europe/Athens'],
  ['Istanbul', 41.0082, 28.9784, 'Europe/Istanbul'],
  ['Tokyo', 35.6762, 139.6503, 'Asia/Tokyo'],
  ['Naha', 26.2124, 127.6809, 'Asia/Tokyo'],
  ['Seoul', 37.5665, 126.978, 'Asia/Seoul'],
  ['Beijing', 39.9042, 116.4074, 'Asia/Shanghai'],
  ['Urumqi', 43.8256, 87.6168, 'Asia/Shanghai'],
  ['Delhi', 28.6139, 77.209, 'Asia/Kolkata'],
  ['Kathmandu', 27.7172, 85.324, 'Asia/Kathmandu'],
  ['Bangkok', 13.7563, 100.5018, 'Asia/Bangkok'],
  ['Singapore', 1.3521, 103.8198, 'Asia/Kuala_Lumpur'],
  ['Bali', -8.4095, 115.1889, 'Asia/Makassar'],
  ['Dubai', 25.2048, 55.2708, 'Asia/Dubai'],
  ['Tehran', 35.6892, 51.389, 'Asia/Tehran'],
  ['Sydney', -33.8688, 151.2093, 'Australia/Sydney'],
  ['Adelaide', -34.9285, 138.6007, 'Australia/Adelaide'],
  ['Perth', -31.9505, 115.8605, 'Australia/Perth'],
  ['Auckland', -36.8485, 174.7633, 'Pacific/Auckland'],
  ['Honolulu', 21.3069, -157.8583, 'Pacific/Honolulu'],
  ['New York', 40.7128, -74.006, 'America/New_York'],
  ['Chicago', 41.8781, -87.6298, 'America/Chicago'],
  ['Denver', 39.7392, -104.9903, 'America/Denver'],
  ['Phoenix', 33.4484, -112.074, 'America/Phoenix'],
  ['Los Angeles', 34.0522, -118.2437, 'America/Los_Angeles'],
  ['Vancouver', 49.2827, -123.1207, 'America/Vancouver'],
  ['St. John\'s', 47.5615, -52.7126, 'America/St_Johns'],
  ['Mexico City', 19.4326, -99.1332, 'America/Mexico_City'],
  ['Cancún', 21.1619, -86.8515, 'America/Cancun'],
  ['Buenos Aires', -34.6037, -58.3816, 'America/Argentina/Buenos_Aires'],
  ['Rio de Janeiro', -22.9068, -43.1729, 'America/Sao_Paulo'],
  ['Lima', -12.0464, -77.0428, 'America/Lima'],
  ['Cairo', 30.0444, 31.2357, 'Africa/Cairo'],
  ['Marrakesh', 31.6295, -7.9811, 'Africa/Casablanca'],
  ['Nairobi', -1.2921, 36.8219, 'Africa/Nairobi'],
  ['Cape Town', -33.9249, 18.4241, 'Africa/Johannesburg'],
];

for (const [name, lat, lng, zone] of CASES) {
  test(`${name} → ${zone}`, () => {
    const r = zoneFromLocation(lat, lng);
    assert.equal(r.zone, zone);
    assert.equal(r.method, 'region');
  });
}

test('mid-ocean falls back to the longitude band, and says so', () => {
  assert.deepEqual(zoneFromLocation(-40, -30), { zone: 'Etc/GMT+2', method: 'longitude' });
  assert.deepEqual(zoneFromLocation(0, 0), { zone: 'Etc/UTC', method: 'longitude' });
  assert.equal(zoneFromLocation(NaN, 4.8).method, 'longitude');
});

test('Lyon in November: a real CET sunrise, not a UTC one', () => {
  const r = sun.sunTimes({ date: '2026-11-03', lat: 45.764, lng: 4.8357, zone: zoneFromLocation(45.764, 4.8357).zone });
  assert.equal(sun.formatTime(r.events.sunrise, r.zone, '24h'), '07:23');
  assert.equal(r.offsetMinutes, 60);
});
