// Time-zone estimate from a location, without a network or a tz-boundary dataset.
//
// Longitude alone is wrong across a lot of the travelled world: all of France,
// Spain, Benelux and Norway keep CET although they sit in the UTC band; China keeps
// one zone across four bands; India, Iran, Nepal and Newfoundland are on half or
// quarter hours; Hawaii rounds to -11 but is -10. So the estimate first tries a
// table of bounding boxes to real IANA zones (DST then comes out right too), in
// order, first match wins — specific boxes before broad ones — and only then falls
// back to the longitude band. A box is deliberately coarse: it is an estimate the
// user can override by pinning a zone on the trip, and the tab says so.
'use strict';

const sun = require('./sun.js');

// [zone, latMin, latMax, lngMin, lngMax]
const BOXES = [
  // ── Europe: exceptions first ─────────────────────────────────────────────
  ['Atlantic/Reykjavik', 63, 67, -25, -13],
  ['Atlantic/Canary', 27.5, 29.5, -18.3, -13.3],
  ['Atlantic/Azores', 36.9, 39.8, -31.3, -24.9],
  ['Atlantic/Madeira', 32.3, 33.2, -17.3, -16.2],
  ['Europe/Lisbon', 36.9, 42.2, -9.6, -6.2],
  ['Europe/Dublin', 51.3, 55.5, -10.7, -5.3],
  ['Europe/London', 51, 61, -8.7, 1.8],
  ['Europe/London', 49.9, 51, -6.5, 1.4],
  ['Europe/Paris', 42.3, 51.2, -5, 8.3],
  ['Europe/Madrid', 36, 43.8, -9.3, 3.4],
  ['Arctic/Longyearbyen', 74, 81, 10, 35],
  ['Europe/Oslo', 68.5, 71.5, 12, 31.5],
  ['Europe/Helsinki', 59.7, 70.1, 20.5, 31.6],
  ['Europe/Riga', 53.9, 59.7, 20.9, 28.3],
  ['Europe/Minsk', 51.2, 56.2, 23.2, 32.8],
  ['Europe/Kyiv', 44.3, 52.4, 22.1, 40.2],
  ['Europe/Bucharest', 41.2, 48.3, 22.3, 30],
  ['Europe/Athens', 35.8, 36.6, 27.5, 28.3], // Rhodes
  ['Europe/Athens', 36.6, 36.95, 26.9, 27.45], // Kos
  ['Europe/Athens', 37.6, 37.85, 26.55, 27.1], // Samos
  ['Europe/Athens', 38.1, 38.65, 25.8, 26.3], // Chios
  ['Europe/Athens', 38.95, 39.45, 25.8, 26.65], // Lesbos
  ['Europe/Istanbul', 35.8, 42.2, 26, 44.8],
  ['Europe/Athens', 34.8, 41.8, 19.3, 29.7],
  ['Asia/Nicosia', 34.5, 35.7, 32.2, 34.6],
  ['Europe/Berlin', 35.8, 71.5, 3, 24],
  ['Europe/Moscow', 41, 70, 27, 60],

  // ── Middle East / Caucasus ───────────────────────────────────────────────
  ['Asia/Jerusalem', 29.4, 33.4, 34.2, 35.9],
  ['Asia/Beirut', 33, 34.7, 35, 36.7],
  ['Asia/Amman', 29.2, 33.4, 34.9, 39.3],
  ['Africa/Cairo', 22, 31.7, 24.7, 36.9],
  ['Asia/Dubai', 22, 26.5, 51, 56.5],
  ['Asia/Muscat', 16.6, 26.4, 52, 60],
  ['Asia/Riyadh', 12.5, 32.2, 34.5, 55.7],
  ['Asia/Baghdad', 29, 37.4, 38.8, 48.6],
  ['Asia/Tehran', 25, 39.8, 44, 63.3],
  ['Asia/Tbilisi', 41, 43.6, 40, 46.7],
  ['Asia/Yerevan', 38.8, 41.3, 43.4, 46.6],
  ['Asia/Baku', 38.4, 41.9, 44.8, 50.4],

  // ── Asia ─────────────────────────────────────────────────────────────────
  ['Asia/Kabul', 29.4, 38.5, 60.5, 74.9],
  ['Asia/Karachi', 23.6, 37.1, 60.9, 74.6],
  ['Asia/Kathmandu', 26.3, 30.5, 80, 88.2],
  ['Asia/Thimphu', 26.7, 28.4, 88.7, 92.2],
  ['Asia/Dhaka', 20.5, 26.7, 88, 92.7],
  ['Asia/Colombo', 5.9, 9.9, 79.6, 81.9],
  ['Asia/Kolkata', 6.5, 35.5, 68, 97.4],
  ['Asia/Yangon', 9.5, 16, 92.2, 99.2],
  ['Asia/Yangon', 16, 20.4, 92.2, 98.5],
  ['Asia/Yangon', 20.4, 28.6, 92.2, 101.2],
  ['Asia/Almaty', 40.5, 55.5, 46.5, 87.4],
  ['Asia/Bishkek', 39.2, 43.3, 69.2, 80.3],
  ['Asia/Tashkent', 37.1, 45.6, 55.9, 73.2],
  ['Asia/Seoul', 33, 43, 124.5, 131],
  ['Asia/Vladivostok', 42.3, 48.5, 130.4, 139],
  ['Asia/Tokyo', 24, 30, 122.9, 131.5],
  ['Asia/Tokyo', 30, 46, 129, 146],
  ['Asia/Vladivostok', 42, 82, 130.5, 180],
  ['Asia/Manila', 4.5, 21.2, 116.9, 126.6],
  ['Asia/Kuala_Lumpur', 0.8, 5.6, 99.6, 119.3],
  ['Asia/Bangkok', 5.6, 23.4, 97.3, 109.5],
  ['Asia/Kuala_Lumpur', 5.6, 7.4, 99.6, 119.3],
  ['Asia/Jakarta', -8.8, 6, 95, 115],
  ['Asia/Makassar', -10.5, 5, 115, 125],
  ['Asia/Jayapura', -9.2, 2.5, 125, 141],
  ['Asia/Shanghai', 18, 53.6, 73.5, 135.1],
  ['Asia/Yekaterinburg', 50, 75, 60, 80],
  ['Asia/Novosibirsk', 49, 75, 80, 95],
  ['Asia/Krasnoyarsk', 49, 80, 95, 110],
  ['Asia/Irkutsk', 49, 75, 110, 120],
  ['Asia/Yakutsk', 49, 78, 120, 130.5],

  // ── Oceania ──────────────────────────────────────────────────────────────
  ['Australia/Perth', -35.2, -13.7, 112.9, 129],
  ['Australia/Darwin', -26, -10.9, 129, 138],
  ['Australia/Adelaide', -38.1, -26, 129, 141],
  ['Australia/Brisbane', -29.2, -10.4, 138, 153.6],
  ['Australia/Sydney', -43.7, -29.2, 141, 153.7],
  ['Pacific/Auckland', -47.5, -34, 166, 179],
  ['Pacific/Fiji', -21, -12, 176.8, 180],
  ['Pacific/Fiji', -21, -12, -180, -178],
  ['Pacific/Honolulu', 18.9, 22.3, -160.3, -154.7],
  ['Pacific/Tahiti', -18, -14.5, -152.5, -147.5],
  ['Pacific/Guam', 13.2, 13.7, 144.6, 145],

  // ── North America ────────────────────────────────────────────────────────
  ['America/St_Johns', 46.6, 51.7, -59.5, -52.5],
  ['America/Halifax', 43.3, 48.1, -67, -59.6],
  ['America/Phoenix', 31.3, 37, -114.8, -109],
  ['America/Los_Angeles', 32.5, 49, -124.8, -114.1],
  ['America/Denver', 31.3, 49, -114.1, -104],
  ['America/Chicago', 25.8, 49, -104, -85.5],
  ['America/New_York', 24.5, 47.5, -85.5, -66.9],
  ['America/Anchorage', 51, 71.5, -179.2, -129.9],
  ['America/Whitehorse', 60, 69.6, -141, -124],
  ['America/Vancouver', 48.2, 60, -139, -120],
  ['America/Edmonton', 49, 60, -120, -110],
  ['America/Regina', 49, 60, -110, -102],
  ['America/Winnipeg', 49, 60, -102, -95.2],
  ['America/Toronto', 41.6, 62.5, -95.2, -57.1],
  ['America/Tijuana', 28, 32.7, -117.2, -112.7],
  ['America/Hermosillo', 26.3, 32.5, -115, -108.4],
  ['America/Cancun', 17.9, 21.7, -89.4, -86.7],
  ['America/Mexico_City', 14.5, 32.7, -118.5, -86.7],
  ['America/Panama', 7.2, 9.7, -83.1, -77.1],
  ['America/Guatemala', 7, 18.5, -92.3, -82.5],
  ['America/Havana', 19.8, 23.3, -85, -74],
  ['America/Jamaica', 17.7, 18.6, -78.4, -76.2],
  ['America/Nassau', 20.9, 27.3, -80.5, -72.7],
  ['America/Santo_Domingo', 17.5, 20, -74.5, -68.3],
  ['America/Puerto_Rico', 17.9, 18.6, -67.3, -65.2],
  ['America/Barbados', 12, 18.5, -63.5, -59.4],

  // ── South America ────────────────────────────────────────────────────────
  ['Pacific/Galapagos', -1.5, 0.7, -92, -89],
  ['Pacific/Easter', -27.3, -27, -109.6, -109.2],
  ['America/Bogota', -4.2, 13.4, -79, -66.9],
  ['America/Guayaquil', -5, 1.5, -81, -75.2],
  ['America/Lima', -18.4, 0, -81.4, -68.7],
  ['America/Caracas', 0.6, 12.2, -73.4, -59.8],
  ['America/La_Paz', -22.9, -9.7, -69.7, -57.5],
  ['America/Santiago', -56, -17.5, -75.7, -66.4],
  ['America/Montevideo', -35, -30, -58.2, -53],
  ['America/Asuncion', -27.6, -19.3, -62.7, -54.3],
  ['America/Argentina/Buenos_Aires', -55.1, -21.8, -73.6, -53.6],
  ['America/Manaus', -14, 5, -73.9, -56],
  ['America/Sao_Paulo', -33.8, 5.3, -60, -34.7],

  // ── Africa ───────────────────────────────────────────────────────────────
  ['Africa/Casablanca', 20.7, 36, -17.2, -1],
  ['Africa/Algiers', 18.9, 37.5, -8.7, 11.6],
  ['Africa/Tripoli', 19.5, 33.2, 9.3, 25.2],
  ['Africa/Khartoum', 8.7, 22, 21.8, 38.6],
  ['Africa/Abidjan', 4, 27, -17.6, 1.3],
  ['Africa/Lagos', -5.1, 23.5, 1.3, 24],
  ['Africa/Nairobi', -12, 15, 29.5, 51.5],
  ['Africa/Johannesburg', -35, -22, 16.4, 33],
  ['Africa/Windhoek', -29, -16.9, 11.7, 25.3],
  ['Africa/Gaborone', -27, -17.8, 20, 29.4],
  ['Africa/Maputo', -27, -8, 21.9, 41],
  ['Africa/Luanda', -18, -4.4, 11.7, 24.1],
  ['Africa/Kinshasa', -13.5, 5.4, 12, 31.3],
  ['Indian/Antananarivo', -25.6, -11.9, 43.2, 50.5],
  ['Indian/Mauritius', -20.6, -19.9, 57.3, 57.9],
  ['Indian/Reunion', -21.4, -20.8, 55.2, 55.9],
  ['Indian/Mahe', -4.8, -3.7, 55.3, 55.9],
  ['Indian/Maldives', -0.7, 7.1, 72.6, 73.8],
];

/**
 * @returns {{ zone: string, method: 'region' | 'longitude' }}
 */
function zoneFromLocation(lat, lng) {
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    for (const [zone, latMin, latMax, lngMin, lngMax] of BOXES) {
      if (lat >= latMin && lat <= latMax && lng >= lngMin && lng <= lngMax) return { zone, method: 'region' };
    }
  }
  return { zone: sun.zoneFromLongitude(Number.isFinite(lng) ? lng : 0), method: 'longitude' };
}

module.exports = { zoneFromLocation, BOXES };
