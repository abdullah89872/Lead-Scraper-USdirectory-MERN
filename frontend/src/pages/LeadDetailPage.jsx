import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink as ExternalLinkIcon } from 'lucide-react';
import api, { errorMessage } from '../lib/api';
import { Alert, Badge, PageHeader, Spinner } from '../components/ui';
import { EMAIL_STATUS_STYLES, ENRICHMENT_STYLES, formatDateTime, formatPhone } from '../lib/format';

function DetailRow({ label, value, mono }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-100 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className={`text-sm font-medium text-slate-900 ${mono ? 'break-all font-mono text-xs' : ''}`}>
        {value || <span className="text-slate-400">Not published</span>}
      </dd>
    </div>
  );
}

function ChipList({ items, empty }) {
  if (!items?.length) return <p className="text-sm text-slate-400">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <Badge key={item} className="bg-slate-100 text-slate-700">
          {item}
        </Badge>
      ))}
    </div>
  );
}

function LeadSection({ title, children }) {
  return (
    <div className="card p-6">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">{title}</h2>
      {children}
    </div>
  );
}

function SourceLink({ href, children }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="inline-flex items-center gap-1 break-all text-brand-600 hover:text-brand-700"
    >
      {children}
      <ExternalLinkIcon size={12} className="shrink-0" />
    </a>
  );
}

/** Full detail view for a single lead, including AI output kept separate. */
export default function LeadDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [lead, setLead] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/leads/${id}`)
      .then(({ data }) => {
        if (!cancelled) setLead(data.lead);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err, 'Could not load lead'));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function onDelete() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete "${lead.businessName}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/leads/${id}`);
      navigate('/leads');
    } catch (err) {
      setError(errorMessage(err, 'Could not delete the lead'));
    }
  }

  if (error && !lead) return <Alert variant="error">{error}</Alert>;
  if (!lead) return <Spinner label="Loading leadâ€¦" />;
return (
    <>
      <PageHeader
        title={lead.businessName}
        subtitle={[lead.category, lead.city, lead.state].filter(Boolean).join(' Â· ')}
        actions={
          <>
            <Link to="/leads" className="btn-secondary">
              <ArrowLeft size={16} />
              Back
            </Link>
            <button type="button" className="btn-danger" onClick={onDelete}>
              Delete
            </button>
          </>
        }
      />

      {lead.demoData ? (
        <div className="mb-4">
          <Alert variant="warning">
            This is synthetic demo data (mock mode). It does not represent a real business.
          </Alert>
        </div>
      ) : null}

      {error ? (
        <div className="mb-4">
          <Alert variant="error" onDismiss={() => setError('')}>
            {error}
          </Alert>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <LeadSection title="Business">
          <dl>
            <DetailRow label="Business name" value={lead.businessName} />
            <DetailRow label="Category" value={lead.category} />
            <DetailRow label="Address" value={lead.address} />
            <DetailRow label="City" value={lead.city} />
            <DetailRow label="State" value={lead.state} />
            <DetailRow label="ZIP" value={lead.zip} />
          </dl>
          {lead.description ? (
            <p className="mt-4 text-sm leading-relaxed text-slate-600">{lead.description}</p>
          ) : null}
        </LeadSection>

        <LeadSection title="Contact">
          <dl>
            <DetailRow label="Phone" value={formatPhone(lead.phone)} />
            <DetailRow
              label="Email"
              value={
                lead.email ? (
                  <a href={`mailto:${lead.email}`} className="text-brand-600 hover:text-brand-700">
                    {lead.email}
                  </a>
                ) : null
              }
            />
            <DetailRow
              label="Website"
              value={<SourceLink href={lead.website}>{lead.website}</SourceLink>}
            />
            <DetailRow
              label="Email status"
              value={<Badge className={EMAIL_STATUS_STYLES[lead.emailStatus]}>{lead.emailStatus}</Badge>}
            />
            <DetailRow
              label="Enrichment"
              value={
                <Badge className={ENRICHMENT_STYLES[lead.enrichmentStatus]}>
                  {lead.enrichmentStatus}
                </Badge>
              }
            />
          </dl>
        </LeadSection>

        <LeadSection title="All public contact points">
          <div className="space-y-4">
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Emails
              </p>
              <ChipList items={lead.publicEmails} empty="None published" />
            </div>
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Phones
              </p>
              <ChipList items={lead.publicPhones} empty="None published" />
            </div>
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Services
              </p>
              <ChipList items={lead.services} empty="None published" />
            </div>
          </div>
        </LeadSection>

        <LeadSection title="Provenance">
          <dl>
            <DetailRow label="Source" value={lead.source} />
            <DetailRow
              label="Source URL"
              value={<SourceLink href={lead.sourceUrl}>{lead.sourceUrl}</SourceLink>}
              mono
            />
            <DetailRow
              label="Contact page"
              value={<SourceLink href={lead.contactPageUrl}>{lead.contactPageUrl}</SourceLink>}
              mono
            />
            <DetailRow label="Scraped at" value={formatDateTime(lead.scrapedAt)} />
            <DetailRow label="Added" value={formatDateTime(lead.createdAt)} />
          </dl>
          {lead.notes?.length ? (
            <ul className="mt-3 space-y-1 text-xs text-slate-500">
              {lead.notes.map((note) => (
                <li key={note}>Â· {note}</li>
              ))}
            </ul>
          ) : null}
        </LeadSection>

        <LeadSection title="AI generated (separate from source data)">
          {lead.aiCategory || lead.aiTags?.length || lead.aiServices?.length ? (
            <div className="space-y-4">
              <DetailRow label="AI category" value={lead.aiCategory} />
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  AI tags
                </p>
                <ChipList items={lead.aiTags} empty="None" />
              </div>
              <div>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  AI services
                </p>
                <ChipList items={lead.aiServices} empty="None" />
              </div>
              {lead.aiDescription ? (
                <p className="text-sm text-slate-600">{lead.aiDescription}</p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              No AI data. AI is optional and never creates contact information.
            </p>
          )}
        </LeadSection>
      </div>
    </>
  );
}