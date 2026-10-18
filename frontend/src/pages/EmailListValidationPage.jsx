import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Copy, Download, Loader2, Mail, Trash2, Upload } from 'lucide-react';
import api, { errorMessage } from '../lib/api';
import { Alert, PageHeader, Spinner } from '../components/ui';
import { formatNumber } from '../lib/format';
import {
  makeValidationCsv,
  normalizeValidationResult,
  ValidationResultsTable,
  ValidationSummary,
} from './EmailValidationShared';

const RESULTS_PER_PAGE = 100;

const parseEmailList = (text) => text
  .replace(/^\uFEFF/, '')
  .split(/[\s,;]+/)
  .map((value) => value.trim())
  .filter((value) => value && !/^(e-?mail|email_address|emailaddress)$/i.test(value));

export default function EmailListValidationPage() {
  const [input, setInput] = useState('');
  const [fileName, setFileName] = useState('');
  const [job, setJob] = useState(null);
  const [results, setResults] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [page, setPage] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const emailCount = useMemo(() => parseEmailList(input).length, [input]);
  const resultCsv = useMemo(() => makeValidationCsv(results), [results]);
  const isRunning = ['queued', 'running'].includes(job?.status);
  const summary = job?.status === 'completed' ? job.summary : null;

  useEffect(() => {
    if (!job?.id || !isRunning) return undefined;
    let cancelled = false;

    async function refreshJob() {
      try {
        const { data } = await api.get(`/validate/jobs/${job.id}`);
        if (!cancelled) setJob(data.job);
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
          setPagination(data.pagination);
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

  useEffect(() => {
    if (job?.status === 'failed') {
      setError(job.error || 'Email validation failed.');
    }
  }, [job?.status, job?.error]);

  async function validate(event) {
    event.preventDefault();
    const emails = parseEmailList(input);
    if (!emails.length) {
      setError('Paste email addresses or choose a file containing only email addresses.');
      return;
    }

    setSubmitting(true);
    setError('');
    setResults([]);
    setPagination({ page: 1, pages: 1, total: 0 });
    setPage(1);
    try {
      const { data } = await api.post('/validate/email-list', { emails });
      setJob(data.job);
    } catch (requestError) {
      setError(errorMessage(requestError, 'Email validation failed'));
    } finally {
      setSubmitting(false);
    }
  }

  async function chooseFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/\.(txt|csv)$/i.test(file.name)) {
      setError('Choose a .txt or .csv file containing only email addresses.');
      return;
    }

    try {
      setInput(await file.text());
      setFileName(file.name);
      setJob(null);
      setResults([]);
      setPagination({ page: 1, pages: 1, total: 0 });
      setError('');
    } catch {
      setError('Could not read that file.');
    }
  }

  function clear() {
    setInput('');
    setFileName('');
    setJob(null);
    setResults([]);
    setPagination({ page: 1, pages: 1, total: 0 });
    setPage(1);
    setError('');
  }

  async function copyResults() {
    try {
      await navigator.clipboard.writeText(resultCsv);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy results to the clipboard. Use Download results instead.');
    }
  }

  async function downloadResults() {
    if (!job?.id) return;
    setError('');
    try {
      const response = await api.get(`/validate/jobs/${job.id}/export/csv`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([response.data], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'email-validation-results.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch (requestError) {
      setError(errorMessage(requestError, 'Could not download validation results'));
    }
  }

  return (
    <>
      <PageHeader
        title="Validate an email list"
        subtitle="Check pasted addresses or a text/CSV file containing only email addresses. Validation includes a best-effort SMTP check; some providers block recipient verification."
        actions={<Link to="/" className="btn-secondary">Dashboard</Link>}
      />

      {error ? <div className="mb-4"><Alert variant="error">{error}</Alert></div> : null}

      <section className="card">
        <form onSubmit={validate}>
          <label htmlFor="email-list" className="label">Email addresses</label>
          <textarea
            id="email-list"
            className="input min-h-40"
            placeholder={'alex@example.com\ninfo@example.org'}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setFileName('');
              setJob(null);
              setResults([]);
              setPagination({ page: 1, pages: 1, total: 0 });
              setPage(1);
              setError('');
            }}
          />
          <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-slate-500">
            <span>{fileName || 'Separate addresses with a new line, comma, or semicolon.'}</span>
            {emailCount ? <span>{formatNumber(emailCount)} emails</span> : null}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <label className="btn-secondary cursor-pointer">
              <Upload size={16} />
              Choose email-list file
              <input type="file" accept=".txt,.csv" className="hidden" onChange={chooseFile} />
            </label>
            <button type="button" className="btn-secondary" onClick={clear} disabled={isRunning || submitting || (!input && !results.length)}>
              <Trash2 size={16} />
              Clear
            </button>
            <button type="submit" className="btn-primary ml-auto" disabled={submitting || isRunning}>
              {submitting || isRunning ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />}
              {submitting || isRunning ? 'Checking…' : 'Validate emails'}
            </button>
          </div>
        </form>
      </section>

      {submitting || isRunning ? (
        <div className="card mt-5">
          <Spinner label={job?.progress?.message || 'Queuing email validation…'} />
          {job?.progress ? (
            <p className="mt-2 text-center text-sm text-slate-500">
              {formatNumber(job.progress.processed)} of {formatNumber(job.progress.total)} checked
              {' '}({job.progress.percent || 0}%)
            </p>
          ) : null}
        </div>
      ) : null}

      {summary ? (
        <section className="card mt-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-slate-900">Email-list results</h2>
              <p className="text-sm text-slate-500">{formatNumber(summary.total)} addresses checked</p>
            </div>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary" onClick={copyResults}>
                <Copy size={16} />
                {copied ? 'Copied' : 'Copy this page'}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={downloadResults}
              >
                <Download size={16} />
                Download results
              </button>
            </div>
          </div>
          <ValidationSummary summary={summary} />
          <p className="mt-3 text-xs text-slate-500">
            SMTP checks are best-effort: providers may block recipient verification, and acceptance does not guarantee the mailbox exists.
          </p>
          {pagination.pages > 1 ? (
            <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
              <span>
                Showing {(page - 1) * RESULTS_PER_PAGE + 1}–
                {Math.min(page * RESULTS_PER_PAGE, pagination.total)} of {formatNumber(pagination.total)}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => current - 1)}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={page >= pagination.pages}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {results.length ? (
        <div className="mt-4"><ValidationResultsTable results={results} /></div>
      ) : null}
    </>
  );
}
