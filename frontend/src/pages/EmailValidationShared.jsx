import { AlertTriangle, CheckCircle2, CircleX } from 'lucide-react';
import { Badge } from '../components/ui';
import { formatNumber } from '../lib/format';

const STATUS_LABELS = {
  valid: 'Valid',
  invalid: 'Invalid',
  risky: 'Risky',
  unknown: 'Unknown',
  error: 'Error',
  pending: 'Pending',
};

const STATUS_STYLES = {
  valid: 'bg-emerald-100 text-emerald-700',
  invalid: 'bg-red-100 text-red-700',
  risky: 'bg-amber-100 text-amber-700',
  unknown: 'bg-slate-100 text-slate-600',
  error: 'bg-red-100 text-red-700',
  pending: 'bg-slate-100 text-slate-600',
};

const STATUS_ICONS = {
  valid: CheckCircle2,
  invalid: CircleX,
  risky: AlertTriangle,
  unknown: AlertTriangle,
  error: CircleX,
};

export function normalizeValidationResult(result) {
  const status = String(result.status || 'unknown').toLowerCase();
  const flags = [];
  if (result.syntaxValid) flags.push('syntax');
  if (result.mxFound) flags.push('mail server');
  if (result.disposable) flags.push('disposable');
  if (result.roleBased) flags.push('role address');
  if (result.freeProvider) flags.push('free provider');
  if (result.smtpAttempted) {
    flags.push(`SMTP ${String(result.smtpResult || 'checked').replace(/_/g, ' ')}`);
  } else if (result.smtpResult && result.smtpResult !== 'not_attempted') {
    flags.push(`SMTP ${String(result.smtpResult).replace(/_/g, ' ')}`);
  } else if (result.smtpResult === 'not_attempted') {
    flags.push('SMTP not attempted');
  }

  return {
    ...result,
    email: result.address || result.email || result.raw || '',
    status,
    flags,
  };
}

export function makeValidationCsv(results) {
  const rows = [
    ['email', 'status', 'confidence', 'flags', 'reason'],
    ...results.map((result) => [
      result.email,
      result.status,
      result.confidence ?? '',
      result.flags.join('; '),
      result.reason || '',
    ]),
  ];

  return rows
    .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

export function downloadCsv(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function ValidationSummary({ summary }) {
  const counts = [
    { label: 'Total', value: summary.total, icon: CheckCircle2, color: 'text-slate-700' },
    { label: 'Valid', value: summary.valid, icon: CheckCircle2, color: 'text-emerald-700' },
    { label: 'Invalid', value: summary.invalid, icon: CircleX, color: 'text-red-700' },
    { label: 'Risky', value: summary.risky, icon: AlertTriangle, color: 'text-amber-700' },
    { label: 'Unknown', value: summary.unknown, icon: AlertTriangle, color: 'text-slate-600' },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
      {counts.map(({ label, value = 0, icon: Icon, color }) => (
        <div key={label} className="rounded-lg bg-slate-50 p-3">
          <div className={`flex items-center gap-2 text-sm ${color}`}>
            <Icon size={16} />
            <span>{label}</span>
          </div>
          <p className="mt-1 text-xl font-semibold text-slate-900">{formatNumber(value)}</p>
        </div>
      ))}
    </div>
  );
}

export function ValidationResultsTable({ results, showRowNumber = false }) {
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              {showRowNumber ? <th className="th text-left">CSV row</th> : null}
              <th className="th text-left">Email</th>
              <th className="th text-left">Result</th>
              <th className="th text-left">Checks</th>
              <th className="th text-left">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {results.map((result, index) => {
              const Icon = STATUS_ICONS[result.status] || AlertTriangle;
              return (
                <tr key={`${result.email}-${result.rowIndex || index}`}>
                  {showRowNumber ? <td className="td text-slate-500">{result.rowIndex ?? '—'}</td> : null}
                  <td className="td max-w-[260px] truncate">{result.email || '—'}</td>
                  <td className="td">
                    <Badge className={STATUS_STYLES[result.status] || STATUS_STYLES.unknown}>
                      <Icon size={14} className="mr-1" />
                      {STATUS_LABELS[result.status] || result.status}
                    </Badge>
                  </td>
                  <td className="td text-xs text-slate-500">{result.flags.join(', ') || '—'}</td>
                  <td className="td max-w-[360px] text-xs text-slate-500">{result.reason || '—'}</td>
                </tr>
              );
            })}
            {!results.length ? (
              <tr>
                <td colSpan={showRowNumber ? 5 : 4} className="td py-8 text-center text-slate-500">
                  No validation results to show yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
