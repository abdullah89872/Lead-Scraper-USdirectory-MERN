import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowRight, Globe, Mail, Phone, Rocket, Users } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import api from '../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '../components/ui';
import { JOB_STATUS_STYLES, formatNumber, formatRelative } from '../lib/format';

const CARDS = [
  { key: 'leads', label: 'Total Leads', icon: Users, accent: 'text-brand-600', bg: 'bg-brand-50' },
  { key: 'emails', label: 'Emails Found', icon: Mail, accent: 'text-emerald-600', bg: 'bg-emerald-50' },
  { key: 'phones', label: 'Phones Found', icon: Phone, accent: 'text-amber-600', bg: 'bg-amber-50' },
  { key: 'websites', label: 'Websites Found', icon: Globe, accent: 'text-violet-600', bg: 'bg-violet-50' },
  { key: 'activeJobs', label: 'Active Jobs', icon: Activity, accent: 'text-sky-600', bg: 'bg-sky-50' },
];

const COVERAGE = [
  { label: 'Emails', key: 'emailPct', color: 'bg-emerald-500' },
  { label: 'Phones', key: 'phonePct', color: 'bg-amber-500' },
  { label: 'Websites', key: 'websitePct', color: 'bg-violet-500' },
];

function StatCard({ card, value }) {
  const Icon = card.icon;
  return (
    <div className="card flex items-center gap-4 p-5">
      <div className={`rounded-lg p-3 ${card.bg}`}>
        <Icon size={22} className={card.accent} />
      </div>
      <div className="min-w-0">
        <p className="text-sm text-slate-500">{card.label}</p>
        <p className="text-2xl font-bold text-slate-900">{formatNumber(value)}</p>
      </div>
    </div>
  );
}

function RecentJobs({ jobs }) {
  return (
    <div className="card mt-6 overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <h2 className="text-sm font-semibold text-slate-900">Recent jobs</h2>
        <Link to="/jobs" className="inline-flex items-center gap-1 text-sm font-medium text-brand-600">
          View all <ArrowRight size={14} />
        </Link>
      </div>

      {jobs.length ? (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Category</th>
                <th className="th">Location</th>
                <th className="th">Status</th>
                <th className="th">Leads</th>
                <th className="th">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td className="td font-medium text-slate-900">{job.category}</td>
                  <td className="td">{job.location}</td>
                  <td className="td">
                    <Badge className={JOB_STATUS_STYLES[job.status]}>{job.status}</Badge>
                  </td>
                  <td className="td">{formatNumber(job.leadsCount)}</td>
                  <td className="td text-slate-500">{formatRelative(job.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={Rocket}
          title="No jobs yet"
          description="Start a scrape to see your jobs here."
          action={
            <Link to="/scrape" className="btn-primary">
              Start scraping
            </Link>
          }
        />
      )}
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .get('/dashboard/stats')
      .then(({ data: payload }) => {
        if (!cancelled) setData(payload);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || 'Could not load dashboard stats');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <Alert variant="error">{error}</Alert>;
  if (!data) return <Spinner label="Loading dashboard…" />;

  const { totals, coverage, leadsByDay, topCategories, recentJobs } = data;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="An overview of everything LeadForge AI has collected for you."
        actions={
          <Link to="/scrape" className="btn-primary">
            <Rocket size={16} />
            New scrape
          </Link>
        }
      />

      {totals.demoData > 0 ? (
        <div className="mb-6">
          <Alert variant="info">
            Mock mode is active — {formatNumber(totals.demoData)} of these leads are synthetic demo
            data and do not represent real businesses.
          </Alert>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {CARDS.map((card) => (
          <StatCard key={card.key} card={card} value={totals[card.key] ?? 0} />
        ))}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold text-slate-900">Leads collected</h2>
          {leadsByDay.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={leadsByDay}>
                <defs>
                  <linearGradient id="leadGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3366ff" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#3366ff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} width={32} />
                <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13 }} />
                <Area type="monotone" dataKey="count" stroke="#3366ff" strokeWidth={2} fill="url(#leadGradient)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState
              title="No leads yet"
              description="Run your first scrape to see leads collected over time."
              action={
                <Link to="/scrape" className="btn-primary">
                  Start scraping
                </Link>
              }
            />
          )}
        </div>

        <div className="card p-5">
          <h2 className="mb-4 text-sm font-semibold text-slate-900">Data coverage</h2>
          <div className="space-y-4">
            {COVERAGE.map((row) => (
              <div key={row.key}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="text-slate-600">{row.label}</span>
                  <span className="font-semibold text-slate-900">{coverage[row.key]}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={`h-full rounded-full ${row.color}`}
                    style={{ width: `${Math.min(100, coverage[row.key])}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          {topCategories.length ? (
            <>
              <h3 className="mb-3 mt-6 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Top categories
              </h3>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={topCategories} layout="vertical">
                  <XAxis type="number" hide />
                  <YAxis
                    type="category"
                    dataKey="category"
                    width={90}
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13 }} />
                  <Bar dataKey="count" fill="#3366ff" radius={[0, 4, 4, 0]} barSize={14} />
                </BarChart>
              </ResponsiveContainer>
            </>
          ) : null}
        </div>
      </div>

      <RecentJobs jobs={recentJobs} />
    </>
  );
}