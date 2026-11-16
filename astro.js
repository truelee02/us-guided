'use strict';
/*
 * Minimal astrology helpers.
 * - Sun sign: exact, from month/day of birth.
 * - Rising sign: APPROXIMATION only. A true ascendant needs an ephemeris and
 *   the exact latitude/longitude; here we rotate the sun sign by roughly one
 *   sign per two hours after an assumed 6 AM sunrise. Good enough for
 *   light-touch advice flavor, and only computed when a birth time is known.
 */
const SIGNS = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
               'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'];

// [month, day] on which each sign starts.
const CUSPS = [
  [1, 20, 'Aquarius'], [2, 19, 'Pisces'], [3, 21, 'Aries'], [4, 20, 'Taurus'],
  [5, 21, 'Gemini'], [6, 21, 'Cancer'], [7, 23, 'Leo'], [8, 23, 'Virgo'],
  [9, 23, 'Libra'], [10, 23, 'Scorpio'], [11, 22, 'Sagittarius'], [12, 22, 'Capricorn'],
];

function sunSign(birthday) {
  if (!birthday) return null;
  const [, m, d] = birthday.split('-').map(Number);
  if (!m || !d) return null;
  let sign = 'Capricorn';
  for (const [cm, cd, name] of CUSPS) {
    if (m > cm || (m === cm && d >= cd)) sign = name;
  }
  return sign;
}

function risingSign(birthday, birthTime) {
  const sun = sunSign(birthday);
  if (!sun || !birthTime) return null;
  const [h] = birthTime.split(':').map(Number);
  if (Number.isNaN(h)) return null;
  const sunIdx = SIGNS.indexOf(sun);
  // Rough model: ascendant ≈ sun sign at ~6 AM, advancing one sign per ~2h.
  const steps = Math.floor((((h - 6) % 24) + 24) % 24 / 2);
  return SIGNS[(sunIdx + steps) % 12];
}

function astroSummary(person) {
  if (!person || !person.astrology_opt_in) return null;
  const sun = sunSign(person.birthday);
  if (!sun) return null;
  const rising = person.birth_time_unknown ? null : risingSign(person.birthday, person.birth_time);
  return { sun, rising: rising || null };
}

module.exports = { sunSign, risingSign, astroSummary, SIGNS };
