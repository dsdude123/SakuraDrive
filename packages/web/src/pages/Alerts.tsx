import { useState } from 'react';
import {
  ALERT_CATEGORIES,
  formatRelative,
  type Alert,
  type AlertCategory,
} from '@sakuradrive/shared';
import { PageHeader } from '../components/Layout.js';
import { Badge, Card, EmptyState, Loading, Modal, SeverityBadge, Table } from '../components/ui.js';
import { useMutation, useQuery } from '../hooks/useApi.js';
import { useToast } from '../hooks/useToast.js';

interface AlertsResponse {
  alerts: Alert[];
  total: number;
  counts: { open: number; critical: number; warning: number; info: number; acknowledged: number };
}

export function AlertsPage(): JSX.Element {
  const [state, setState] = useState<'open' | 'resolved' | 'any'>('open');
  const [category, setCategory] = useState<AlertCategory | ''>('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Alert | null>(null);

  const { data, loading, refresh } = useQuery<AlertsResponse>('/api/alerts', {
    query: { state, category: category || undefined, search: search || undefined, limit: 200 },
    pollMs: 20_000,
  });
  const mutation = useMutation();
  const toast = useToast();

  const act = async (alert: Alert, action: 'acknowledge' | 'unacknowledge' | 'resolve') => {
    const result = await mutation.run(`/api/alerts/${alert.id}/${action}`);
    if (result) {
      toast.push(`Alert ${action}d`, 'success');
      refresh();
      setSelected(null);
    } else if (mutation.error) {
      toast.push(mutation.error, 'error');
    }
  };

  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle="Conditions, not events — an alert stays open until the condition clears"
      />
      <div className="content">
        <Card flush>
          <div className="card-header">
            <div className="toolbar" style={{ flex: 1 }}>
              <select value={state} onChange={(event) => setState(event.target.value as typeof state)} style={{ width: 150 }}>
                <option value="open">Open &amp; acknowledged</option>
                <option value="resolved">Resolved</option>
                <option value="any">All</option>
              </select>
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value as AlertCategory | '')}
                style={{ width: 160 }}
              >
                <option value="">Every category</option>
                {ALERT_CATEGORIES.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
              <input
                className="grow"
                type="search"
                placeholder="Search title and detail…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            {data && (
              <div className="button-row">
                <Badge tone="critical">{data.counts.critical} critical</Badge>
                <Badge tone="warning">{data.counts.warning} warning</Badge>
                <Badge tone="info">{data.counts.info} info</Badge>
              </div>
            )}
          </div>

          {loading && !data && <Loading />}
          {data && data.alerts.length === 0 && (
            <EmptyState title="Nothing here">
              {state === 'open'
                ? 'No open alerts. Everything the monitors can see is healthy.'
                : 'No alerts match these filters.'}
            </EmptyState>
          )}
          {data && data.alerts.length > 0 && (
            <Table headers={['Severity', 'Alert', 'Category', 'Seen', 'First seen', '#Times', '']}>
              {data.alerts.map((alert) => (
                <tr key={alert.id} className="clickable" onClick={() => setSelected(alert)}>
                  <td>
                    <SeverityBadge severity={alert.severity} />
                    {alert.state === 'acknowledged' && (
                      <div style={{ marginTop: 4 }}>
                        <Badge>acked</Badge>
                      </div>
                    )}
                    {alert.state === 'resolved' && (
                      <div style={{ marginTop: 4 }}>
                        <Badge tone="ok">resolved</Badge>
                      </div>
                    )}
                  </td>
                  <td>
                    <div>{alert.title}</div>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {alert.detail.slice(0, 160)}
                    </div>
                  </td>
                  <td>
                    <Badge>{alert.category}</Badge>
                  </td>
                  <td className="nowrap muted">{formatRelative(alert.lastSeenAt)}</td>
                  <td className="nowrap muted">{formatRelative(alert.firstSeenAt)}</td>
                  <td className="num">{alert.occurrences}</td>
                  <td onClick={(event) => event.stopPropagation()}>
                    <div className="button-row">
                      {alert.state === 'open' && (
                        <button className="small" onClick={() => void act(alert, 'acknowledge')}>
                          Ack
                        </button>
                      )}
                      {alert.state === 'acknowledged' && (
                        <button className="small" onClick={() => void act(alert, 'unacknowledge')}>
                          Unack
                        </button>
                      )}
                      {alert.state !== 'resolved' && (
                        <button className="small ghost" onClick={() => void act(alert, 'resolve')}>
                          Resolve
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      {selected && (
        <Modal
          title={selected.title}
          onClose={() => setSelected(null)}
          actions={
            <>
              {selected.state === 'open' && (
                <button onClick={() => void act(selected, 'acknowledge')}>Acknowledge</button>
              )}
              {selected.state !== 'resolved' && (
                <button className="primary" onClick={() => void act(selected, 'resolve')}>
                  Mark resolved
                </button>
              )}
            </>
          }
        >
          <div className="stack">
            <div className="row wrap">
              <SeverityBadge severity={selected.severity} />
              <Badge>{selected.category}</Badge>
              <span className="muted">
                seen {selected.occurrences} time{selected.occurrences === 1 ? '' : 's'} since{' '}
                {formatRelative(selected.firstSeenAt)}
              </span>
            </div>
            <p style={{ margin: 0 }}>{selected.detail}</p>
            {Object.keys(selected.context).length > 0 && (
              <dl className="kv">
                {Object.entries(selected.context).map(([key, value]) => (
                  <div key={key} style={{ display: 'contents' }}>
                    <dt>{key}</dt>
                    <dd className="mono">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="faint" style={{ fontSize: 12 }}>
              Resolving an alert by hand is a statement about the world, not about the alert: if the
              condition is still true, the next collector run raises it again.
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
