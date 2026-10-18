import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import api, { errorMessage } from '../lib/api';
import { Alert, PageHeader, Spinner } from '../components/ui';
import { formatNumber } from '../lib/format';
import {
  normalizeValidationResult,
  ValidationResultsTable,
  ValidationSummary,
} from './EmailValidationShared';

const RESULTS_PER_PAGE = 100;

export default function LeadsCsvValidationPage() {
  const [file, setFile] = useState(null);
  const [job, setJob] = useState(null);
  const [results, setResults] = useState([]);
  const [resultsPagination, setResultsPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const isRunning = ['queued', 'running'].includes(job?.status);

  useEffect(() => {
    if (!job?.id || !isRunning) return undefined;
    let cancelled = false;

    async function refreshJob() {
      try {
        const { data } = await api.get(`/validate/jobs/${job.id}`);
        if (!cancelled) {
          setJob((current) => ({
            ...data.job,
            emailColumn: current?.emailColumn,
            rowCount: current?.rowCount,
            sourceFileName: current?.sourceFileName,
          }));
        }
      } catch (requestError) {
        if (!cancelled) setError(errorMessage(requestError, 'Could not check validation progress'));
      }
    }

    refreshJob();
    const timer = window.setInterval(refreshJob, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [job?.id, isRunning]);

  useEffect(() => {
    if (job?.status !== 'completed') return undefined;
    let cancelled = false;

    async function loadResults() {
      try {
        const { data } = await api.get(`/validate/jobs/${job.id}/results`, {
          params: { page, limit: RESULTS_PER_PAGE },
        });
        if (!cancelled) {
          setResults(data.results.map(normalizeValidationResult));
          setResultsPagination(data.pagination);
        }
      } catch (requestError) {
        if (!cancelled) setError(errorMessage(requestError, 'Could not load validation results'));
      }
    }

    loadResults();
    return () => {
      cancelled = true;
    };
  }, [job?.id, job?.status, page]);

  async function submit(event) {
    event.preventDefault();
    if (!file) {
      setError('Choose a CSV containing your leads first.');
      return;
    }

    const body = new FormData();
    body.append('file', file);
    setUploading(true);
    setError('');
    setJob(null);
    setResults([]);
    setResultsPagination({ page: 1, pages: 1, total: 0 });
    setPage(1);

    try {
      const { data } = await api.post('/validate/csv', body, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setJob({
        ...data.job,
        emailColumn: data.emailColumn,
        rowCount: data.rowCount,
      });
    } catch (requestError) {
      setError(errorMessage(requestError, 'Could not upload the leads CSV'));
    } finally {
      setUploading(false);
    }
  }

  async function downloadValidLeads() {
    if (!job?.id) return;
    setError('');
    try {
      const response = await api.get(
        `/validate/jobs/${job.id}/export/valid-leads.csv`,
        { responseType: 'blob' }
      );
      const url = URL.createObjectURL(new Blob([response.data], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      const baseName = (job.sourceFileName || 'leads').replace(/\.csv$/i, '');
      link.href = url;
      link.download = `${baseName}-valid-leads.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (requestError) {
      setError(errorMessage(requestError, 'Could not download valid leads'));
    }
  }

  function clear() {
    setFile(null);
    setJob(null);
    setResults([]);
    setResultsPagination({ page: 1, pages: 1, total: 0 });
    setPage(1);
    setError('');
  }

  return (
    <>
      <PageHeader
        title="Validate a full leads CSV"
        subtitle="Upload your complete leads export, validate its email column with a best-effort SMTP check, and download the original rows for valid emails."
        actions={<Link to="/leads" className="btn-secondary">View leads</Link>}
      />

      {error ? <div className="mb-4"><Alert variant="error">{error}</Alert></div> : null}

      <section className="card">
        <div className="mb-5 flex items-start gap-3">
          <div className="rounded-lg bg-brand-50 p-2 text-brand-700">
            <FileSpreadsheet size={21} />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Keep your full lead data</h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-500">
              We detect the email column, check every non-empty email, and keep the original business, phone, website, and other columns for the valid-leads download.
            </p>
          </div>
        </div>

        <form onSubmit={submit}>
          <label htmlFor="leads-csv" className="label">Choose the full leads CSV</label>
          <input
            id="leads-csv"
            type="file"
            accept=".csv,text/csv"
            className="input"
            onChange={(event) => {
              setFile(event.target.files?.[0] || null);
              setJob(null);
              setResults([]);
              setError('');
            }}
          />
          <p className="mt-2 text-xs text-slate-500">
            For example, export a leads CSV from the Leads page. The file needs a column named Email or another header containing “email”.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 truncate text-sm text-slate-600">{file?.name || 'No file selected'}</p>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary" onClick={clear} disabled={!file && !job}>
                Clear
              </button>
              <button type="submit" className="btn-primary" disabled={!file || uploading || isRunning}>
                {uploading || isRunning
                  ? <Loader2 size={16} className="animate-spin" />
                  : <Upload size={16} />}
                {uploading ? 'Uploading…' : isRunning ? 'Validating…' : 'Upload and validate'}
              </button>
            </div>
          </div>
        </form>
      </section>

      {job ? (
        <section className="card mt-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold text-slate-900">
                {job.status === 'completed'
                  ? 'Validation complete'
                  : job.status === 'failed'
                    ? 'Validation failed'
                    : 'Validation in progress'}
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Detected email column: <strong className="text-slate-700">{job.emailColumn}</strong>
                {job.rowCount != null ? ` · ${formatNumber(job.rowCount)} lead rows in file` : ''}
              </p>
            </div>
            <span className="text-sm font-medium text-slate-600">{job.progress?.percent || 0}%</span>
          </div>

          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full bg-brand-600 transition-all"
              style={{ width: `${job.progress?.percent || 0}%` }}
            />
          </div>

          {isRunning ? (
            <div className="mt-3 flex items-center gap-2 text-sm text-slate-500">
              <Loader2 size={16} className="animate-spin" />
              {job.progress?.message || 'Checking email addresses…'}
            </div>
          ) : null}
          {job.status === 'failed' ? (
            <p className="mt-3 text-sm text-red-700">{job.error || job.progress?.message}</p>
          ) : null}

          {job.status === 'completed' ? (
            <div className="mt-5">
              <ValidationSummary summary={job.summary || {}} />
              <p className="mt-3 text-xs text-slate-500">
                The download preserves all uploaded columns and includes only rows whose email was marked Valid. Risky, invalid, and unknown results are excluded.
              </p>
              <button
                type="button"
                className="btn-primary mt-4"
                onClick={downloadValidLeads}
                disabled={!job.summary?.valid}
              >
                <Download size={16} />
                Download valid leads CSV
              </button>
              {!job.summary?.valid ? (
                <p className="mt-2 text-sm text-slate-500">No leads were marked valid, so there is nothing to download.</p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {job?.status === 'completed' ? (
        <section className="mt-5">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-slate-900">Validation results</h2>
              <p className="text-sm text-slate-500">
                {formatNumber(resultsPagination.total)} emails · page {resultsPagination.page} of {resultsPagination.pages}
              </p>
            </div>
            {!results.length ? <Spinner label="Loading results…" className="py-3" /> : null}
          </div>
          <ValidationResultsTable results={results} showRowNumber />
          {resultsPagination.pages > 1 ? (
            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                className="btn-secondary"
                disabled={page <= 1}
                onClick={() => setPage((current) => current - 1)}
              >
                Previous
              </button>
              <span className="text-sm text-slate-500">
                Page {resultsPagination.page} of {resultsPagination.pages}
              </span>
              <button
                type="button"
                className="btn-secondary"
                disabled={page >= resultsPagination.pages}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
