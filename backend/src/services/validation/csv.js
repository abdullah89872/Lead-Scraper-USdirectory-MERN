'use strict';

/**
 * CSV helpers for email validation import/export.
 *
 * Import: parse uploaded CSV, detect the email column, return rows.
 * Export: render validation results to CSV with formula-injection protection
 * and UTF-8 BOM for Excel compatibility.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { parse } = require('csv-parse/sync');
const env = require('../../config/env');

/** Characters that can start a formula in spreadsheet apps. */
const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t']);

/** Max cells per row guard. */
const MAX_CELLS = 200;

/**
/**
 * Escape a CSV cell value per RFC 4180.
 * Fields containing comma, quote, or newline must be quoted.
 * Internal quotes are doubled.
 */
function escapeCell(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Sanitize a cell value to prevent formula injection.
 * Values starting with formula prefixes are prefixed with a tab (invisible
 * in most spreadsheet apps) so they are treated as text.
 */
function sanitizeCell(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.length > 0 && FORMULA_PREFIXES.has(str[0])) {
    return `\t${str}`;
  }
  return str;
}

/**
 * Detect the most likely email column in a CSV header row.
 * Returns the column name or null.
 */
function detectEmailColumn(headers) {
  if (!Array.isArray(headers) || headers.length === 0) return null;

  const scored = headers.map((h, idx) => {
    const name = String(h || '').trim().toLowerCase();
    let score = 0;
    if (name === 'email' || name === 'e-mail' || name === 'email_address' || name === 'emailaddress') score += 100;
    if (name.includes('email')) score += 50;
    if (name.includes('mail')) score += 20;
    if (name.includes('contact')) score += 10;
    return { index: idx, name: String(h || '').trim(), score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].score > 0 ? scored[0].name : null;
}

/**
 * Build CSV text from an array of row objects and a field list.
 * Applies sanitization and RFC 4180 escaping.
 */
function buildCsvText(rows, fields) {
  const header = fields.map(escapeCell).join(',');
  const lines = rows.map((row) => fields.map((f) => escapeCell(sanitizeCell(row[f]))).join(','));
  return [header, ...lines].join('\n');
}

/**
 * Parse an uploaded CSV file into rows.
 * Returns { headers, rows, emailColumn, rowCount }.
 */
function parseUploadCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    max_rows: env.validation.csv.maxRows,
    relax_column_count: true,
    relax_quotes: true,
  });

  if (!records || records.length === 0) {
    return { headers: [], rows: [], emailColumn: null, rowCount: 0 };
  }

  const headers = Object.keys(records[0]);
  const emailColumn = detectEmailColumn(headers);
  const rows = records.map((record, idx) => ({
    ...record,
    rowIndex: idx + 2, // 1-based + header row
  }));

  return { headers, rows, emailColumn, rowCount: rows.length };
}

/**
 * Export validation results to CSV.
 * Returns a Buffer (UTF-8 with BOM).
 *
 * @param {object[]} results - validation result objects
 * @param {object} options - { includeRaw, includeLeadMeta, filename }
 * @returns {Buffer}
 */
function exportResultsCsv(results, options = {}) {
  const { includeRaw = false, includeLeadMeta = false } = options;

  const baseFields = [
    'raw',
    'address',
    'normalized',
    'status',
    'confidence',
    'reason',
    'syntaxValid',
    'domainExists',
    'mxFound',
    'fallbackUsed',
    'disposable',
    'roleBased',
    'freeProvider',
    'smtpAttempted',
    'smtpResult',
    'smtpCode',
    'smtpMessage',
    'catchAll',
    'updatedAt',
  ];

  const metaFields = includeLeadMeta
    ? ['leadId', 'firstName', 'lastName', 'company', 'source']
    : [];

  const fields = includeRaw ? ['raw', ...baseFields, ...metaFields] : [...baseFields, ...metaFields];

  const csvText = buildCsvText(results, fields);
  return Buffer.from(`\uFEFF${csvText}`, 'utf8');
}

/**
 * Write CSV results to a temp file and return the path.
 * Caller is responsible for cleanup.
 */
function exportResultsToFile(results, options = {}) {
  const dir = os.tmpdir();
  const filename = options.filename || `validation-results-${Date.now()}.csv`;
  const filePath = path.join(dir, filename);
  const buffer = exportResultsCsv(results, options);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

module.exports = {
  sanitizeCell,
  buildCsvText,
  detectEmailColumn,
  parseUploadCsv,
  exportResultsCsv,
  exportResultsToFile,
};