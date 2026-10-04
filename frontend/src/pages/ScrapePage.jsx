import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Rocket, ShieldCheck } from 'lucide-react';
import api, { errorMessage } from '../lib/api';
import { Alert, Field, PageHeader, Toggle } from '../components/ui';

const SOURCES = [{ id: 'usdirectory', name: 'USdirectory.com' }];
const MAX_LEADS = 1000;

/** "Scrape Leads" form: category + location + options -> create a job. */
export default function ScrapePage() {
  const navigate = useNavigate();

  const [form, setForm] = useState({
    source: 'usdirectory',
    category: '',
    location: '',
    maxLeads: 100,
    enrichment: true,
    ai: false,
  });
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get('/settings')
      .then(({ data }) => setSettings(data))
      .catch(() => setSettings(null));
  }, []);

  const update = (key) => (event) => {
    const value = event.target.type === 'number' ? Number(event.target.value) : event.target.value;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const aiAvailable = Boolean(settings?.ai?.enabled);

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post('/jobs', form);
      navigate(`/jobs/${data.job.id}`);
    } catch (err) {
      setError(errorMessage(err, 'Could not start the scrape'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Scrape Leads"
        subtitle="Pick a category and location and LeadForge AI will collect the matching public listings."
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <form onSubmit={onSubmit} className="card p-6 lg:col-span-2">
          <div className="space-y-5">
            {error ? (
              <Alert variant="error" onDismiss={() => setError('')}>
                {error}
              </Alert>
            ) : null}

            <Field label="Source" required>
              <select className="input" value={form.source} onChange={update('source')}>
                {SOURCES.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
            </Field>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Field label="Category" required hint="e.g. Roofing, Plumbing, Dentist">
                <input
                  className="input"
                  value={form.category}
                  onChange={update('category')}
                  placeholder="Roofing"
                  minLength={2}
                  maxLength={120}
                  required
                />
              </Field>

              <Field label="Location" required hint='e.g. "Hillsboro, Oregon"'>
                <input
                  className="input"
                  value={form.location}
                  onChange={update('location')}
                  placeholder="Hillsboro, Oregon"
                  minLength={2}
                  maxLength={160}
                  required
                />
              </Field>
            </div>

            <Field label="Maximum Leads" hint={`Between 1 and ${MAX_LEADS}.`}>
              <input
                className="input"
                type="number"
                min={1}
                max={MAX_LEADS}
                value={form.maxLeads}
                onChange={update('maxLeads')}
                required
              />
            </Field>

            <div className="space-y-3">
              <Toggle
                checked={form.enrichment}
                onChange={(value) => setForm((prev) => ({ ...prev, enrichment: value }))}
                label="Website Enrichment"
                description="Visit each business website and read contact details it publishes publicly."
              />
              <Toggle
                checked={form.ai}
                onChange={(value) => setForm((prev) => ({ ...prev, ai: value }))}
                label="AI Processing"
                description={
                  aiAvailable
                    ? 'Generate categories, services and tags. Never contact details.'
                    : 'Set AI_ENABLED=true and OPENAI_API_KEY to enable AI tagging.'
                }
                disabled={!aiAvailable}
              />
            </div>

            <button type="submit" className="btn-primary w-full sm:w-auto" disabled={busy}>
              <Rocket size={16} />
              {busy ? 'Starting…' : 'Start Scraping'}
            </button>
          </div>
        </form>

        <ScrapeSidebar settings={settings} />
      </div>
    </>
  );
}
function ScrapeSidebar({ settings }) {
  return (
    <aside className="space-y-4">
      <div className="card p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <ShieldCheck size={16} className="text-emerald-600" />
          Responsible scraping
        </h2>
        <ul className="mt-3 space-y-2 text-sm text-slate-600">
          <li>· Reads only publicly displayed business information.</li>
          <li>· Respects robots.txt and applies conservative request delays.</li>
          <li>· Stops and backs off if a site restricts access — never bypasses it.</li>
          <li>· Missing fields stay empty; nothing is invented.</li>
        </ul>
      </div>

      {settings ? (
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-slate-900">Environment</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Scraper mode</dt>
              <dd className="font-medium text-slate-900">{settings.scraper.mode}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Enrichment</dt>
              <dd className="font-medium text-slate-900">
                {settings.enrichment.enabled ? 'on' : 'off'}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">AI</dt>
              <dd className="font-medium text-slate-900">
                {settings.ai.enabled ? settings.ai.model : 'disabled'}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
    </aside>
  );
}