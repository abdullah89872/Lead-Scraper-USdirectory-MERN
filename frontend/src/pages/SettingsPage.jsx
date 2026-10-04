import { useEffect, useState } from 'react';
import { CheckCircle2, Cpu, Database, Server, XCircle } from 'lucide-react';
import api from '../lib/api';
import { Alert, Badge, PageHeader, Spinner } from '../components/ui';
import { useAuth } from '../context/AuthContext';

function StatusRow({ label, ok, value }) {
  const Icon = ok ? CheckCircle2 : XCircle;
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="inline-flex items-center gap-1.5 font-medium text-slate-900">
        <Icon size={15} className={ok ? 'text-emerald-600' : 'text-slate-400'} />
        {value}
      </span>
    </div>
  );
}

function Panel({ title, icon: Icon, children }) {
  return (
    <div className="card p-6">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
        <Icon size={16} className="text-brand-600" />
        {title}
      </h2>
      {children}
    </div>
  );
}

/** Read-only view of the runtime configuration (never any secrets). */
export default function SettingsPage() {
  const { user } = useAuth();
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/settings')
      .then(({ data }) => setSettings(data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load settings'));
  }, []);

  if (error) return <Alert variant="error">{error}</Alert>;
  if (!settings) return <Spinner label="Loading settings…" />;

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Runtime configuration for this deployment. Secrets are never shown here."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Account" icon={Server}>
          <dl className="divide-y divide-slate-100">
            <div className="flex justify-between py-2 text-sm">
              <dt className="text-slate-500">Name</dt>
              <dd className="font-medium text-slate-900">{user?.name}</dd>
            </div>
            <div className="flex justify-between py-2 text-sm">
              <dt className="text-slate-500">Email</dt>
              <dd className="font-medium text-slate-900">{user?.email}</dd>
            </div>
            <div className="flex justify-between py-2 text-sm">
              <dt className="text-slate-500">Role</dt>
              <dd>
                <Badge className="bg-brand-100 text-brand-700">{user?.role}</Badge>
              </dd>
            </div>
          </dl>
        </Panel>

        <Panel title="Scraper service" icon={Server}>
          <div className="divide-y divide-slate-100">
            <StatusRow
              label="Mode"
              ok
              value={
                <Badge
                  className={
                    settings.scraper.mode === 'mock'
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-emerald-100 text-emerald-700'
                  }
                >
                  {settings.scraper.mode}
                </Badge>
              }
            />
            <StatusRow label="Service" ok={settings.scraper.reachable} value={settings.scraper.reachable ? 'online' : 'offline'} />
            <StatusRow label="URL" ok value={settings.scraper.url} />
            <StatusRow
              label="Website enrichment"
              ok={settings.enrichment.enabled}
              value={settings.enrichment.enabled ? 'enabled' : 'disabled'}
            />
          </div>
          {settings.scraper.mode === 'mock' ? (
            <p className="mt-3 text-xs text-slate-500">
              Mock mode returns synthetic demo leads and never contacts USdirectory.
            </p>
          ) : null}
        </Panel>

        <Panel title="Queue" icon={Database}>
          <div className="divide-y divide-slate-100">
            <StatusRow
              label="Driver"
              ok
              value={settings.queue.driver || 'not started'}
            />
            <StatusRow label="Concurrency" ok value={settings.queue.concurrency} />
          </div>
          <p className="mt-3 text-xs text-slate-500">
            BullMQ + Redis when Redis is reachable, otherwise jobs run in-process.
          </p>
        </Panel>

        <Panel title="AI processing" icon={Cpu}>
          <div className="divide-y divide-slate-100">
            <StatusRow
              label="Status"
              ok={settings.ai.enabled}
              value={settings.ai.enabled ? 'enabled' : 'disabled'}
            />
            <StatusRow label="Model" ok value={settings.ai.model} />
            <StatusRow
              label="API key"
              ok={settings.ai.configured}
              value={settings.ai.configured ? 'configured' : 'not set'}
            />
          </div>
          <p className="mt-3 text-xs text-slate-500">
            AI only produces categories, services, tags and summaries. It never creates or guesses
            contact information, and scraping continues if AI fails.
          </p>
        </Panel>
      </div>
    </>
  );
}