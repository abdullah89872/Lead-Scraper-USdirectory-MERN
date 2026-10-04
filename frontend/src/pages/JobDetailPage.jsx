import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Ban, ExternalLink } from 'lucide-react';
import api, { errorMessage } from '../lib/api';
import { useJobProgress } from '../hooks/useJobProgress';
import { Alert, Badge, PageHeader, Spinner } from '../components/ui';
import { JOB_STATUS_STYLES, formatDateTime, formatNumber } from '../lib/format';

function StatRow({ label, value }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-900">{value}</dd>
    </div>
  );
}

/** Single job view with live SSE progress and a cancel action. */
export default function JobDetailPage() {
  const { id } = useParams();
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleUpdate = useCallback((incoming) => setJob(incoming), []);
  const { connected } = useJobProgress(id, handleUpdate);

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/jobs/${id}`)
      .then(({ data }) => {
        if (!cancelled) setJob(data.job);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err, 'Could not load job'));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function cancelJob() {
    setBusy(true);
    try {
      const { data } = await api.post(`/jobs/${id}/cancel`);
      setJob(data.job);
    } catch (err) {
      setError(errorMessage(err, 'Could not cancel the job'));
    } finally {
      setBusy(false);
    }
  }

  if (error && !job) return <Alert variant="error">{error}</Alert>;
  if (!job) return <Spinner label="Loading job…" />;

  const progress = job.progress || {};
  const percent = progress.percent ?? 0;
  const active = job.status === 'queued' || job.status === 'running';

  return (
    <>
      <PageHeader
        title={job.category}
        subtitle={job.location}
        actions={
          <>
            <Link to="/jobs" className="btn-secondary">
              <ArrowLeft size={16} />
              Back
            </Link>
            {active ? (
              <button type="button" className="btn-danger" onClick={cancelJob} disabled={busy}>
                <Ban size={16} />
                Cancel
              </button>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="card p-6 lg:col-span-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Badge className={JOB_STATUS_STYLES[job.status]}>{job.status}</Badge>
              {active ? (
                <span className="text-xs text-slate-500">
                  {connected ? 'live updates' : 'polling for updates'}
                </span>
              ) : null}
            </div>
            <span className="text-sm font-semibold text-slate-900">{percent}%</span>
          </div>

          <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                job.status === 'failed'
                  ? 'bg-red-500'
                  : job.status === 'cancelled'
                    ? 'bg-amber-500'
                    : 'bg-brand-600'
              }`}
              style={{ width: `${percent}%` }}
            />
          </div>

          <p className="mt-3 text-sm text-slate-600">{progress.message}</p>

          {job.error ? (
            <div className="mt-4">
              <Alert variant="error">{job.error}</Alert>
            </div>
          ) : null}

          {job.warnings?.length ? (
            <div className="mt-4 space-y-2">
              {job.warnings.map((warning) => (
                <Alert key={warning} variant="warning">
                  {warning}
                </Alert>
              ))}
            </div>
          ) : null}

          {job.status === 'completed' ? (
            <div className="mt-6">
              <Link
                to={`/leads?job=${job.id}`}
                className="btn-primary"
              >
                View {formatNumber(job.leadsCount)} leads
              </Link>
            </div>
          ) : null}
        </div>

        <aside className="card p-6">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Job details</h2>
          <dl className="divide-y divide-slate-100">
            <StatRow label="Status" value={job.status} />
            <StatRow label="Source" value={job.source} />
            <StatRow label="Mode" value={job.mode} />
            <StatRow label="Requested" value={formatNumber(job.maxLeads)} />
            <StatRow label="Leads found" value={formatNumber(job.leadsCount)} />
            <StatRow label="Duplicates merged" value={formatNumber(job.duplicatesMerged)} />
            <StatRow label="Possible duplicates" value={formatNumber(job.possibleDuplicates)} />
            <StatRow label="Created" value={formatDateTime(job.createdAt)} />
            <StatRow label="Completed" value={formatDateTime(job.completedAt)} />
          </dl>

          {progress.leadsFound ? (
            <p className="mt-4 text-xs text-slate-500">
              {formatNumber(progress.leadsFound)} listings discovered so far
            </p>
          ) : null}

          {error ? (
            <div className="mt-4">
              <Alert variant="error" onDismiss={() => setError('')}>
                {error}
              </Alert>
            </div>
          ) : null}
        </aside>
      </div>
    </>
  );
}