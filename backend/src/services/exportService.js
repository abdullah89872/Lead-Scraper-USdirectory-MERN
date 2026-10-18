'use strict';

/** Server-side CSV and XLSX export (streams large result sets). */

const ExcelJS = require('exceljs');
const ExportRecord = require('../models/ExportRecord');
const { EXPORT_COLUMNS, iterateLeads, toExportRow } = require('./leadService');

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Stream CSV directly to the HTTP response. */
async function streamCsv({ user, query, res, onFinish }) {
  const columns = query.emailsOnly
    ? EXPORT_COLUMNS.filter((column) => column.key === 'email')
    : EXPORT_COLUMNS;
  const filePrefix = query.emailsOnly ? 'leadforge-emails' : 'leadforge-leads';
  const fileName = `${filePrefix}-${timestamp()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.write(`${columns.map((column) => csvCell(column.header)).join(',')}\n`);

  let count = 0;
  let bytes = res.getHeader('Content-Length') ? Number(res.getHeader('Content-Length')) : 0;
  for await (const batch of iterateLeads(user, query)) {
    for (const lead of batch) {
      const row = toExportRow(lead);
      const line = columns.map((column) => csvCell(row[column.key])).join(',');
      res.write(`${line}\n`);
      count += 1;
      bytes += Buffer.byteLength(line) + 1;
    }
  }
  res.end();

  if (onFinish) await onFinish({ fileName, count, bytes });
  return { fileName, count, bytes };
}

/** Stream an XLSX workbook to the HTTP response. */
async function streamXlsx({ user, query, res, onFinish }) {
  const columns = query.emailsOnly
    ? EXPORT_COLUMNS.filter((column) => column.key === 'email')
    : EXPORT_COLUMNS;
  const filePrefix = query.emailsOnly ? 'leadforge-emails' : 'leadforge-leads';
  const fileName = `${filePrefix}-${timestamp()}.xlsx`;
  // ExcelJS streams raw bytes into the response without touching HTTP headers,
  // so the attachment metadata has to be set before the first write.
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: res,
    useStyles: true,
    useSharedStrings: false,
  });
  workbook.creator = 'LeadForge AI';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Leads', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: Math.min(60, Math.max(12, column.width)),
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).commit();

  let count = 0;
  for await (const batch of iterateLeads(user, query)) {
    for (const lead of batch) {
      sheet.addRow(toExportRow(lead)).commit();
      count += 1;
    }
  }
  sheet.commit();
  await workbook.commit();

  const bytes = Number(res.getHeader('Content-Length') || 0);
  if (onFinish) await onFinish({ fileName, count, bytes });
  return { fileName, count, bytes };
}

/** Record the export in the audit trail (best effort). */
async function recordExport({ user, format, query, fileName, count, bytes, status = 'completed' }) {
  try {
    await ExportRecord.create({
      user,
      format,
      filters: {
        search: query.search || null,
        category: query.category || null,
        state: query.state || null,
        city: query.city || null,
        source: query.source || null,
        hasEmail: query.hasEmail || null,
        emailsOnly: query.emailsOnly || null,
        emailStatus: query.emailStatus || null,
        hasPhone: query.hasPhone || null,
        hasWebsite: query.hasWebsite || null,
        ids: query.ids || null,
      },
      fileName,
      leadCount: count,
      bytes,
      status,
    });
  } catch (error) {
    // never fail an export because the audit row could not be written
  }
}

module.exports = { recordExport, streamCsv, streamXlsx };
