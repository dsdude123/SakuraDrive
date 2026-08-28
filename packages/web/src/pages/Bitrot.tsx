import { useState } from 'react';
import { formatBytes, formatRelative, type BitrotFinding, type BitrotStatus } from '@sakuradrive/shared';
import { PageHeader } from '../components/Layout.js';
import { Badge, Banner, Card, EmptyState, Loading, Modal, Table } from '../components/ui.js';
import { useMutation, useQuery } from '../hooks/useApi.js';
import { useToast } from '../hooks/useToast.js';

interface BitrotResponse {
  findings: BitrotFinding[];
  total: number;
  counts: { open: number; confirmed: number; dismissed: number; resolved: number };
}

export function BitrotPage(): JSX.Element {
  const [status, setStatus] = useState<'active' | BitrotStatus | 'any'>('active');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [noteFor, setNoteFor] = useState<{ ids: number[]; status: BitrotStatus } | null>(null);
  const [note, setNote] = useState('');

  const { data, loading, refresh } = useQuery<BitrotResponse>('/api/bitrot', {
    query: { status, search: search || undefined, limit: 500 },
    pollMs: 30_000,
  });
  const mutation = useMutation();
  const toast = useToast();

  const apply = async (ids: number[], next: BitrotStatus, withNote = '') => {
    const result = await mutation.run('/api/bitrot/status', {
      body: { ids, status: next, note: withNote },
    });
    if (result) {
      toast.push(`${ids.length} finding${ids.length === 1 ? '' : 's'} marked ${next}`, 'success');
      setSelected(new Set());
      setNoteFor(null);
      setNote('');
      refresh();
    } else if (mutation.error) {
      toast.push(mutation.error, 'error');
    }
  };

  const toggle = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  return (
    <>
      <PageHeader
        title="Bit rot"
        subtitle="Files whose content changed while their size and timestamp did not"
        actions={
          <a className="button" href="/api/bitrot.csv">
            Export CSV
          </a>
        }
      />
      <div className="content">
        <Banner tone="info" title="How a finding is raised">
          Every hashed file records its hash alongside the size and modification time at the moment
          it was read. When the re-verification pass finds a different hash while size and timestamp
          are unchanged, nothing legitimate wrote to that file — the bytes on disk changed underneath
          the filesystem. Each finding is re-read once before being confirmed, so a one-off
          controller glitch does not raise a false alarm.
        </Banner>

        {data && (
          <div className="grid cols-4">
            <div className="stat critical">
              <span className="label">Confirmed</span>
              <span className="value">{data.counts.confirmed}</span>
              <span className="hint">mismatch reproduced on a second read</span>
            </div>
            <div className="stat warning">
              <span className="label">Unverified</span>
              <span className="value">{data.counts.open}</span>
              <span className="hint">detected but not reproduced</span>
            </div>
            <div className="stat">
              <span className="label">Dismissed</span>
              <span className="value">{data.counts.dismissed}</span>
              <span className="hint">known false positives</span>
            </div>
            <div className="stat ok">
              <span className="label">Resolved</span>
              <span className="value">{data.counts.resolved}</span>
              <span className="hint">restored from backup</span>
            </div>
          </div>
        )}

        <Card flush>
          <div className="card-header">
            <div className="toolbar" style={{ flex: 1 }}>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as typeof status)}
                style={{ width: 190 }}
              >
                <option value="active">Needs attention</option>
                <option value="confirmed">Confirmed only</option>
                <option value="open">Unverified only</option>
                <option value="dismissed">Dismissed</option>
                <option value="resolved">Resolved</option>
                <option value="any">Everything</option>
              </select>
              <input
                className="grow"
                type="search"
                placeholder="Filter by path…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            {selected.size > 0 && (
              <div className="button-row">
                <span className="muted nowrap">{selected.size} selected</span>
                <button onClick={() => setNoteFor({ ids: [...selected], status: 'resolved' })}>
                  Mark resolved
                </button>
                <button className="ghost" onClick={() => setNoteFor({ ids: [...selected], status: 'dismissed' })}>
                  Dismiss
                </button>
              </div>
            )}
          </div>

          {loading && !data && <Loading />}
          {data && data.findings.length === 0 && (
            <EmptyState title="No bit rot detected">
              Every file whose hash has been re-verified still matches the hash recorded when it was
              first read.
            </EmptyState>
          )}
          {data && data.findings.length > 0 && (
            <Table
              headers={[
                <input
                  key="all"
                  type="checkbox"
                  aria-label="Select all"
                  checked={selected.size === data.findings.length}
                  onChange={(event) =>
                    setSelected(event.target.checked ? new Set(data.findings.map((f) => f.id)) : new Set())
                  }
                />,
                'Path',
                '#Size',
                'Expected',
                'Found',
                'Detected',
                'Status',
                '',
              ]}
            >
              {data.findings.map((finding) => (
                <tr key={finding.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${finding.relPath}`}
                      checked={selected.has(finding.id)}
                      onChange={() => toggle(finding.id)}
                    />
                  </td>
                  <td className="path" title={finding.relPath}>
                    {finding.relPath}
                    <div className="faint" style={{ fontSize: 11 }}>
                      {finding.rootId}
                      {finding.previousHashedAt &&
                        ` · last verified ${formatRelative(finding.previousHashedAt)}`}
                    </div>
                  </td>
                  <td className="num">{formatBytes(finding.sizeBytes)}</td>
                  <td className="mono faint">{finding.expectedHash.slice(0, 12)}</td>
                  <td className="mono" style={{ color: 'var(--critical)' }}>
                    {finding.actualHash.slice(0, 12)}
                  </td>
                  <td className="nowrap muted">{formatRelative(finding.detectedAt)}</td>
                  <td>
                    <Badge
                      tone={
                        finding.status === 'confirmed'
                          ? 'critical'
                          : finding.status === 'open'
                            ? 'warning'
                            : finding.status === 'resolved'
                              ? 'ok'
                              : 'neutral'
                      }
                    >
                      {finding.status}
                    </Badge>
                    {finding.note && (
                      <div className="faint" style={{ fontSize: 11 }}>
                        {finding.note}
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="button-row">
                      {finding.status !== 'resolved' && (
                        <button
                          className="small"
                          onClick={() => setNoteFor({ ids: [finding.id], status: 'resolved' })}
                        >
                          Resolved
                        </button>
                      )}
                      {finding.status !== 'dismissed' && (
                        <button
                          className="small ghost"
                          onClick={() => setNoteFor({ ids: [finding.id], status: 'dismissed' })}
                        >
                          Dismiss
                        </button>
                      )}
                      {(finding.status === 'dismissed' || finding.status === 'resolved') && (
                        <button className="small ghost" onClick={() => void apply([finding.id], 'open')}>
                          Reopen
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

      {noteFor && (
        <Modal
          title={noteFor.status === 'resolved' ? 'Mark as resolved' : 'Dismiss finding'}
          onClose={() => setNoteFor(null)}
          actions={
            <>
              <button className="ghost" onClick={() => setNoteFor(null)}>
                Cancel
              </button>
              <button className="primary" onClick={() => void apply(noteFor.ids, noteFor.status, note)}>
                {noteFor.status === 'resolved' ? 'Mark resolved' : 'Dismiss'}
              </button>
            </>
          }
        >
          <div className="stack">
            <p style={{ margin: 0 }} className="muted">
              {noteFor.status === 'resolved'
                ? 'Use this once the file has been restored from backup. The next hash of the file records its new content as the reference.'
                : 'Use this when the change is explained — an application that rewrites files while preserving their timestamp, for example.'}
            </p>
            <label className="field">
              <span>Note (optional)</span>
              <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} />
            </label>
          </div>
        </Modal>
      )}
    </>
  );
}
