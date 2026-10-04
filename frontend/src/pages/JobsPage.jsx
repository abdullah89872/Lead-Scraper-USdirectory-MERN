import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileSpreadsheet, Plus } from 'lucide-react';
import api from '../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '../components/ui';
import { JOB_STATUS_STYLES, formatDateTime, formatNumber } from '../lib/format';

const STATUSES = ['', 'queued', 'running', 'completed', 'failed', 'cancelled'];

function JobRow({ job }) {
  const percent = job.progress?.percent ?? 0;
  return (
    <tr className="hover:bg-slate-50">
      <td className="td">
        <Link to={`/jobs/${job.id}`} className="font-medium text-brand-600 hover:text-brand-700">
          {job.category}
        </Link>
      </td>
      <td className="td text-slate-500">{job.source}</td>
      <td className="td">{job.location}</td>
      <td className="td">
        <Badge className={JOB_STATUS_STYLES[job.status]}>{job.status}</Badge>
      </td>
      <td className="td">
        <div className="flex w-32 items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full rounded-full bg-brand-600 transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="text-xs text-slate-500">{percent}%</span>
        </div>
      </td>
      <td className="td">{formatNumber(job.leadsCount)}</td>
      <td className="td text-slate-500">{formatDateTime(job.createdAt)}</td>
      <td className="td text-slate-500">{formatDateTime(job.completedAt)}</td>
    </tr>
  );
}

/** Jobs table with a status filter and pagination. */
export default function JobsPage() {
  const [jobs, setJobs] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const params = { page, limit: 20 };
      if (status) params.status = status;
      const { data } = await api.get('/jobs', { params });
      setJobs(data.jobs);
      setPagination(data.pagination);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load jobs');
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    load();
  }, [load]);

  // Keep polling only while something is still in flight.
  useEffect(() => {
    const hasActive = jobs.some((job) => job.status === 'queued' || job.status === 'running');
    if (!hasActive) return undefined;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [jobs, load]);
return (
    <>
      <PageHeader
        title="Jobs"
        subtitle="Every scrape you have started, with live progress and results."
        actions={
          <Link to="/scrape" className="btn-primary">
            <Plus size={16} />
            New job
          </Link>
        }
      />

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
          {STATUSES.map((value) => (
            <button
              key={value || 'all'}
              type="button"
              onClick={() => {
                setStatus(value);
                setPage(1);
              }}
              className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
                status === value
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {value || 'all'}
            </button>
          ))}
        </div>

        {error ? (
          <div className="p-4">
            <Alert variant="error">{error}</Alert>
          </div>
        ) : null}

        {loading && !jobs.length ? (
          <Spinner label="Loading jobs…" />
        ) : jobs.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Category</th>
                  <th className="th">Source</th>
                  <th className="th">Location</th>
                  <th className="th">Status</th>
                  <th className="th">Progress</th>
                  <th className="th">Leads</th>
                  <th className="th">Created</th>
                  <th className="th">Completed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {jobs.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={FileSpreadsheet}
            title="No jobs found"
            description="Start a scrape to see it listed here with live progress."
            action={
              <Link to="/scrape" className="btn-primary">
                Start scraping
              </Link>
            }
          />
        )}

        {pagination.pages > 1 ? (
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm">
            <span className="text-slate-500">
              Page {pagination.page} of {pagination.pages} · {formatNumber(pagination.total)} jobs
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary"
                disabled={page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={page >= pagination.pages}
                onClick={() => setPage((value) => value + 1)}
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}