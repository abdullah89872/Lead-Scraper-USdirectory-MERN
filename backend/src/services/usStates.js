'use strict';

/**
 * Minimal US state helpers for normalization and URL building.
 * Not a location list: users can scrape any US location they like.
 */

const STATE_NAME_TO_ABBR = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY',
};

const ABBR_SET = new Set(Object.values(STATE_NAME_TO_ABBR));

function stateAbbr(value) {
  if (!value) return null;
  const candidate = String(value).replace(/\s+/g, ' ').trim().toLowerCase().replace(/\.$/, '');
  if (STATE_NAME_TO_ABBR[candidate]) return STATE_NAME_TO_ABBR[candidate];
  const upper = candidate.toUpperCase();
  if (ABBR_SET.has(upper)) return upper;
  return null;
}

function parseLocation(location) {
  const raw = String(location || '').replace(/\s+/g, ' ').trim();
  if (!raw) return { raw, city: null, state: null, stateAbbr: null };

  const parts = raw.split(',').map((piece) => piece.trim()).filter(Boolean);
  let city = null;
  let state = null;

  if (parts.length >= 2) {
    city = parts[0];
    state = parts[parts.length - 1];
  } else {
    const tokens = parts[0].split(' ');
    if (tokens.length >= 2 && stateAbbr(tokens[tokens.length - 1])) {
      state = tokens[tokens.length - 1];
      city = tokens.slice(0, -1).join(' ');
    } else if (stateAbbr(parts[0])) {
      state = parts[0];
    } else {
      city = parts[0];
    }
  }

  const abbr = stateAbbr(state);
  return {
    raw,
    city: abbr ? city : parts.length >= 2 ? null : city,
    state: abbr ? state : null,
    stateAbbr: abbr,
  };
}

module.exports = { STATE_NAME_TO_ABBR, parseLocation, stateAbbr };
