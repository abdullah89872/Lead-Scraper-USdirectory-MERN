import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileDown } from 'lucide-react';
import api from '../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '../components/ui';
import { formatDateTime, formatNumber } from '../lib/format';

/** Export history — a record of every CSV/XLSX download. */
export default function ExportsPage() {
  const [exports, setExports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/exports', { params: { limit: 50 } });
      setExports(data.exports);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load export history');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <PageHeader
        title="Exports"
        subtitle="Every CSV and XLSX export you have downloaded, with the filters used."
        actions={
          <Link to="/leads" className="btn-primary">
            <Download size={16} />
            Go to leads
          </Link>
        }
      />

      {error ? (
        <div className="mb-4">
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}

      <div className="card overflow-hidden">
        {loading ? (
          <Spinner label="Loading exports…" />
        ) : exports.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Format</th>
                  <th className="th">File</th>
                  <th className="th">Leads</th>
                  <th className="th">Size</th>
                  <th className="th">Filters</th>
                  <th className="th">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {exports.map((record) => (
                  <tr key={record.id}>
                    <td className="td">
                      <Badge
                        className={
                          record.format === 'csv'
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-sky-100 text-sky-700'
                        }
                      >
                        {record.format.toUpperCase()}
                      </Badge>
                    </td>
                    <td className="td max-w-[280px] truncate text-slate-500">{record.fileName}</td>
                    <td className="td">{formatNumber(record.leadCount)}</td>
                    <td className="td">{record.bytes ? `${(record.bytes / 1024).toFixed(1)} KB` : '—'}</td>
                    <td className="td max-w-[260px] truncate text-slate-500">
                      {Object.entries(record.filters || {})
                        .filter(([, value]) => value)
                        .map(([key, value]) => `${key}=${value}`)
                        .join(', ') || 'no filters'}
                    </td>
                    <td className="td text-slate-500">{formatDateTime(record.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={FileDown}
            title="No exports yet"
            description="Export your leads from the Leads page and they will be listed here."
            action={
              <Link to="/leads" className="btn-primary">
                Go to leads
              </Link>
            }
          />
        )}
      </div>
    </>
  );
}