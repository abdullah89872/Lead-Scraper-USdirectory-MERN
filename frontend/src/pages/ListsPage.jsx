import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { List as ListIcon, Plus, Trash2 } from 'lucide-react';
import api, { errorMessage } from '../lib/api';
import { Alert, EmptyState, Field, PageHeader, Spinner } from '../components/ui';
import { formatDateTime, formatNumber } from '../lib/format';

/** Saved lead lists. */
export default function ListsPage() {
  const [lists, setLists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/lists');
      setLists(data.lists);
    } catch (err) {
      setError(errorMessage(err, 'Could not load lists'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createList(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/lists', { name });
      setName('');
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not create the list'));
    } finally {
      setBusy(false);
    }
  }

  async function removeList(list) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete the list "${list.name}"? The leads themselves are kept.`)) return;
    try {
      await api.delete(`/lists/${list.id}`);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not delete the list'));
    }
  }

  return (
    <>
      <PageHeader
        title="Lists"
        subtitle="Group leads you are working on so you can export them together."
      />

      {error ? (
        <div className="mb-4">
          <Alert variant="error" onDismiss={() => setError('')}>
            {error}
          </Alert>
        </div>
      ) : null}

      <form onSubmit={createList} className="card mb-6 flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-[240px] flex-1">
          <Field label="New list name">
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Hillsboro roofers — Q1"
              required
              maxLength={120}
            />
          </Field>
        </div>
        <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>
          <Plus size={16} />
          Create list
        </button>
      </form>

      {loading ? (
        <Spinner label="Loading lists…" />
      ) : lists.length ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {lists.map((list) => (
            <div key={list.id} className="card p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-semibold text-slate-900">{list.name}</h2>
                  {list.description ? (
                    <p className="mt-1 text-sm text-slate-500">{list.description}</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => removeList(list)}
                  aria-label={`Delete ${list.name}`}
                  className="shrink-0 text-slate-400 transition-colors hover:text-red-600"
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <p className="mt-3 text-sm text-slate-500">
                {formatNumber(list.leadCount)} lead{list.leadCount === 1 ? '' : 's'} · updated{' '}
                {formatDateTime(list.updatedAt)}
              </p>
              <Link to={`/leads?list=${list.id}`} className="btn-secondary mt-4 w-full">
                View leads
              </Link>
            </div>
          ))}
        </div>
      ) : (
        <div className="card">
          <EmptyState
            icon={ListIcon}
            title="No lists yet"
            description="Create a list above, then filter your leads and save the selection."
          />
        </div>
      )}
    </>
  );
}