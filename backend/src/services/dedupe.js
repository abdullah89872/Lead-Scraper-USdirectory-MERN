'use strict';

/**
 * Lead deduplication (mirrors the Python scraper implementation).
 *
 * Exact matches on any of these keys are merged:
 *   source URL | source id | email | phone | name+city+state | name+address
 *
 * Uncertain matches (very similar names in the same city that share no contact
 * point) are flagged with possibleDuplicate and kept as separate records.
 */

const NAME_SUFFIXES = new Set([
  'llc', 'inc', 'incorporated', 'co', 'company', 'corp', 'corporation',
  'ltd', 'llp', 'pllc', 'group', 'holdings', 'the', 'and',
]);

const normalizeText = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

function normalizeName(value) {
  const text = normalizeText(value).replace(/[^a-z0-9 ]+/g, ' ');
  return text
    .split(' ')
    .filter((token) => token && !NAME_SUFFIXES.has(token))
    .join(' ')
    .trim();
}

function compactPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function dedupeKeys(lead = {}) {
  const keys = [];
  if (lead.sourceUrl) keys.push(`url:${normalizeText(lead.sourceUrl)}`);
  if (lead.sourceId) keys.push(`src:${lead.source || ''}:${lead.sourceId}`);

  const emails = new Set([...(lead.publicEmails || []), lead.email].filter(Boolean));
  emails.forEach((email) => keys.push(`email:${String(email).toLowerCase().trim()}`));

  const phones = new Set([...(lead.publicPhones || []), lead.phone].filter(Boolean));
  phones.forEach((phone) => keys.push(`phone:${compactPhone(phone)}`));

  const name = normalizeName(lead.businessName);
  if (name) {
    const city = normalizeText(lead.city);
    const state = normalizeText(lead.state);
    if (city) keys.push(`ncs:${name}|${city}|${state}`);
    if (lead.address) keys.push(`na:${name}|${normalizeText(lead.address)}`);
  }
  return keys;
}

function nameSimilarity(a, b) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  // Dice coefficient over token bigrams - good enough for business names.
  const bigrams = (value) => {
    const set = new Set();
    for (let i = 0; i < value.length - 1; i += 1) set.add(value.slice(i, i + 2));
    return set;
  };
  const setA = bigrams(left);
  const setB = bigrams(right);
  let shared = 0;
  setA.forEach((gram) => {
    if (setB.has(gram)) shared += 1;
  });
  return (2 * shared) / (setA.size + setB.size || 1);
}

function mergeLeadInto(target, source) {
  const scalar = [
    'category', 'description', 'address', 'city', 'state', 'zip', 'phone',
    'email', 'website', 'sourceId', 'contactPageUrl', 'aiCategory',
    'aiDescription',
  ];
  scalar.forEach((field) => {
    if (!target[field] && source[field]) target[field] = source[field];
  });

  const union = (left, right) => Array.from(new Set([...(left || []), ...(right || [])].filter(Boolean)));
  target.publicEmails = union(target.publicEmails, source.publicEmails);
  target.publicPhones = union(target.publicPhones, source.publicPhones);
  target.services = union(target.services, source.services);
  target.aiTags = union(target.aiTags, source.aiTags);
  target.aiServices = union(target.aiServices, source.aiServices);
  target.enrichmentSources = union(target.enrichmentSources, source.enrichmentSources);
  target.notes = union(target.notes, source.notes);

  if (!target.email && target.publicEmails.length) target.email = target.publicEmails[0];
  if (!target.phone && target.publicPhones.length) target.phone = target.publicPhones[0];
  if (target.enrichmentStatus === 'not_attempted' && source.enrichmentStatus !== 'not_attempted') {
    target.enrichmentStatus = source.enrichmentStatus;
  }
  if (target.emailStatus === 'unknown' && source.emailStatus && source.emailStatus !== 'unknown') {
    target.emailStatus = source.emailStatus;
  }
  return target;
}

/**
 * Deduplicate an array of in-memory leads.
 *
 * `fuzzyThreshold` only controls *flagging* of uncertain matches. It mirrors the
 * Python scraper (0.82) so both sides label the same pair the same way, and a
 * similar name alone never merges two records.
 */
function dedupeLeads(leads = [], { fuzzyThreshold = 0.82 } = {}) {
  const seen = new Map();
  const unique = [];
  let removed = 0;

  leads.forEach((lead) => {
    const keys = dedupeKeys(lead);
    const existing = keys.map((key) => seen.get(key)).find(Boolean);
    if (existing) {
      mergeLeadInto(existing, lead);
      removed += 1;
    } else {
      unique.push(lead);
    }
    dedupeKeys(existing || lead).forEach((key) => {
      if (!seen.has(key)) seen.set(key, existing || lead);
    });
  });

  let possibleDuplicates = 0;
  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      const a = unique[i];
      const b = unique[j];
      if (a.possibleDuplicate && b.possibleDuplicate) continue;
      const sameCity = normalizeText(a.city) && normalizeText(a.city) === normalizeText(b.city);
      const sameState = normalizeText(a.state) === normalizeText(b.state);
      if (!sameCity || !sameState) continue;
      if (nameSimilarity(a.businessName, b.businessName) >= fuzzyThreshold) {
        a.possibleDuplicate = true;
        b.possibleDuplicate = true;
        a.duplicateReason = a.duplicateReason || `similar name to '${b.businessName}' in the same city`;
        b.duplicateReason = b.duplicateReason || `similar name to '${a.businessName}' in the same city`;
        possibleDuplicates += 1;
      }
    }
  }

  return { leads: unique, removed, possibleDuplicates };
}

module.exports = { dedupeKeys, dedupeLeads, mergeLeadInto, nameSimilarity, normalizeName };
