import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, Search, Trash2, Users } from 'lucide-react';
import api, { errorMessage } from '../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner, Toggle } from '../components/ui';
import { EMAIL_STATUS_STYLES, displayHost, formatNumber, formatPhone } from '../lib/format';

const PAGE_SIZE = 25;
const TOGGLES = [
  ['hasEmail', 'Has email'],
  ['hasPhone', 'Has phone'],
  ['hasWebsite', 'Has website'],
];

/**
 * Download an export through axios so the Authorization header is sent, then
 * hand the blob to the browser as a normal file download.
 */
async function downloadExport(format, params) {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== '' && value != null)
  );
  const response = await api.get(`/leads/export/${format}`, {
    params: Object.fromEntries(query.entries()),
    responseType: 'blob',
  });

  const blobUrl = URL.createObjectURL(new Blob([response.data]));
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = `${params.emailsOnly ? 'leadforge-emails' : 'leadforge-leads'}.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(blobUrl);
}

function LeadRow({ lead, selected, onToggle, onDelete }) {
  return (
    <tr className={selected ? 'bg-brand-50/40' : 'hover:bg-slate-50'}>
      <td className="td">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(lead.id)}
          aria-label={`Select ${lead.businessName}`}
          className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        />
      </td>
      <td className="td">
        <Link to={`/leads/${lead.id}`} className="font-medium text-brand-600 hover:text-brand-700">
          {lead.businessName}
        </Link>
        {lead.possibleDuplicate ? (
          <Badge className="ml-2 bg-amber-100 text-amber-700">possible duplicate</Badge>
        ) : null}
      </td>
      <td className="td max-w-[180px] truncate">{lead.category || '-'}</td>
      <td className="td">{[lead.city, lead.state].filter(Boolean).join(', ') || '-'}</td>
      <td className="td">{formatPhone(lead.phone)}</td>
      <td className="td max-w-[220px] truncate">{lead.email || '-'}</td>
      <td className="td max-w-[160px] truncate">
        {lead.website ? (
          <a
            href={lead.website}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-brand-600 hover:text-brand-700"
          >
            {displayHost(lead.website)}
          </a>
        ) : (
          '-'
        )}
      </td>
      <td className="td text-slate-500">{lead.source}</td>
      <td className="td">
        <Badge className={EMAIL_STATUS_STYLES[lead.emailStatus]}>{lead.emailStatus}</Badge>
      </td>
      <td className="td">
        <button
          type="button"
          onClick={() => onDelete(lead)}
          className="text-slate-400 transition-colors hover:text-red-600"
          aria-label={`Delete ${lead.businessName}`}
        >
          <Trash2 size={16} />
        </button>
      </td>
    </tr>
  );
}

function Filters({ search, setSearch, filters, searchParams, setFilter }) {
  return (
    <div className="card mb-4 p-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setFilter('search', search);
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="min-w-[220px] flex-1">
          <label className="label" htmlFor="lead-search">
            Search
          </label>
          <div className="relative">
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              id="lead-search"
              className="input pl-9"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Business, email, phone, city..."
            />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="filter-category">
            Category
          </label>
          <select
            id="filter-category"
            className="input"
            value={searchParams.get('category') || ''}
            onChange={(event) => setFilter('category', event.target.value)}
          >
            <option value="">All categories</option>
            {filters.categories.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="filter-city">
            City
          </label>
          <select
            id="filter-city"
            className="input"
            value={searchParams.get('city') || ''}
            onChange={(event) => setFilter('city', event.target.value)}
          >
            <option value="">All cities</option>
            {filters.cities.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        <div className="flex gap-2">
          {TOGGLES.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key, searchParams.get(key) ? '' : 'true')}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                searchParams.get(key)
                  ? 'border-brand-600 bg-brand-50 text-brand-700'
                  : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}
export default function LeadsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [leads, setLeads] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [filters, setFilters] = useState({ categories: [], cities: [], sources: [] });
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState(searchParams.get('search') || '');
  const [validOnly, setValidOnly] = useState(true);
  const [emailsOnly, setEmailsOnly] = useState(false);

  // The URL is the single source of truth for the current view.
  const query = useMemo(() => {
    const params = Object.fromEntries(searchParams.entries());
    return { ...params, limit: PAGE_SIZE };
  }, [searchParams]);

  const load = useCallback(async () => {
    setError('');
    try {
      const { data } = await api.get('/leads', { params: query });
      setLeads(data.leads);
      setPagination(data.pagination);
      setSelected(new Set());
    } catch (err) {
      setError(errorMessage(err, 'Could not load leads'));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api
      .get('/leads/meta/filters')
      .then(({ data }) => setFilters(data))
      .catch(() => setFilters({ categories: [], cities: [], sources: [] }));
  }, []);

  /** Merge a patch into the URL. */
  function setFilter(key, value) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setSearchParams(next);
  }

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onDelete(lead) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete "${lead.businessName}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/leads/${lead.id}`);
      setLeads((prev) => prev.filter((item) => item.id !== lead.id));
      setPagination((prev) => ({ ...prev, total: Math.max(0, prev.total - 1) }));
    } catch (err) {
      setError(errorMessage(err, 'Could not delete the lead'));
    }
  }

  async function onExport(format) {
    setError('');
    try {
      // Selected rows win over the active filters.
      const params = selected.size ? { ids: [...selected].join(',') } : { ...query };
      // Only export leads whose email has been validated as valid.
      if (validOnly && !selected.size) params.emailStatus = 'valid';
      if (emailsOnly) {
        params.emailsOnly = 'true';
        params.hasEmail = 'true';
      }
      await downloadExport(format, params);
    } catch (err) {
      setError(errorMessage(err, 'Export failed'));
    }
  }

  const allChecked = leads.length > 0 && leads.every((lead) => selected.has(lead.id));
  const page = Number(pagination.page) || 1;
  const pages = Number(pagination.pages) || 1;
return (
    <>
      <PageHeader
        title="Leads"
        subtitle="Search, filter and export every business LeadForge AI has collected."
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Toggle
              checked={validOnly}
              onChange={setValidOnly}
              label="Valid emails only"
              description="Export only leads with a validated email address"
            />
            <Toggle
              checked={emailsOnly}
              onChange={setEmailsOnly}
              label="Emails only"
              description="Export just email addresses and exclude leads without one"
            />
            <button type="button" className="btn-secondary" onClick={() => onExport('csv')}>
              <Download size={16} />
              CSV
            </button>
            <button type="button" className="btn-secondary" onClick={() => onExport('xlsx')}>
              <Download size={16} />
              XLSX
            </button>
            <Link to="/scrape" className="btn-primary">
              New scrape
            </Link>
          </div>
        }
      />

      {error ? (
        <div className="mb-4">
          <Alert variant="error" onDismiss={() => setError('')}>
            {error}
          </Alert>
        </div>
      ) : null}

      {selected.size ? (
        <div className="mb-4">
          <Alert variant="info">
            {selected.size} lead{selected.size === 1 ? '' : 's'} selected. The export buttons will
            download only these rows.
          </Alert>
        </div>
      ) : null}

      <Filters
        search={search}
        setSearch={setSearch}
        filters={filters}
        searchParams={searchParams}
        setFilter={setFilter}
      />

      <div className="card overflow-hidden">
        {loading && !leads.length ? (
          <Spinner label="Loading leads..." />
        ) : leads.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th w-10">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={() =>
                        setSelected(allChecked ? new Set() : new Set(leads.map((lead) => lead.id)))
                      }
                      aria-label="Select all leads on this page"
                      className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                  </th>
                  <th className="th">Business</th>
                  <th className="th">Category</th>
                  <th className="th">Location</th>
                  <th className="th">Phone</th>
                  <th className="th">Email</th>
                  <th className="th">Website</th>
                  <th className="th">Source</th>
                  <th className="th">Email status</th>
                  <th className="th w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {leads.map((lead) => (
                  <LeadRow
                    key={lead.id}
                    lead={lead}
                    selected={selected.has(lead.id)}
                    onToggle={toggle}
                    onDelete={onDelete}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={Users}
            title="No leads found"
            description="Adjust your filters, or run a new scrape to collect more leads."
            action={
              <Link to="/scrape" className="btn-primary">
                Start scraping
              </Link>
            }
          />
        )}

        {pages > 1 ? (
          <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm">
            <span className="text-slate-500">
              Page {page} of {pages} | {formatNumber(pagination.total)} leads
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary"
                disabled={page <= 1}
                onClick={() => setFilter('page', String(page - 1))}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={page >= pages}
                onClick={() => setFilter('page', String(page + 1))}
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