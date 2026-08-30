import { formatBytes, formatCount, formatDurationMs, formatRelative } from '@sakuradrive/shared';
import { PageHeader } from '../components/Layout.js';
import { ProgressBar } from '../components/ProgressBar.js';
import { Badge, Banner, Card, EmptyState, Loading, Table } from '../components/ui.js';
import { useMutation, useQuery } from '../hooks/useApi.js';
import { useToast } from '../hooks/useToast.js';

interface AgentJob {
  id: number;
  type: 'catalog.scan' | 'catalog.hash';
  rootId: string;
  rootName: string;
  hostPath: string;
  state: 'queued' | 'claimed' | 'completed' | 'paused' | 'failed' | 'cancelled';
  claimedBy: string | null;
  error: string | null;
  cancelRequested: boolean;
  createdAt: string;
  claimedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
  elapsedMs: number;
  silentForMs: number | null;
  queuedForMs: number | null;
  filesSeen: number;
  bytesSeen: number;
  dirsDone: number;
  dirsRemaining: number;
  filesPerSecond: number | null;
}

interface JobsResponse {
  active: AgentJob[];
  queued: AgentJob[];
  recent: AgentJob[];
  claimTimeoutSeconds: number;
}

const TYPE_LABEL: Record<AgentJob['type'], string> = {
  'catalog.scan': 'Catalog scan',
  'catalog.hash': 'Bit-rot hashing',
};

/** An agent that has not spoken for this long is probably not coming back. */
const SILENT_WARNING_MS = 120_000;

function StateBadge({ job }: { job: AgentJob }): JSX.Element {
  if (job.cancelRequested && job.state === 'claimed') return <Badge tone="warning">stopping</Badge>;
  switch (job.state) {
    case 'claimed':
      return <Badge tone="ok">running</Badge>;
    case 'queued':
      return <Badge tone="warning">waiting for an agent</Badge>;
    case 'completed':
      return <Badge tone="ok">completed</Badge>;
    case 'paused':
      return <Badge>paused</Badge>;
    case 'failed':
      return <Badge tone="critical">failed</Badge>;
    default:
      return <Badge>cancelled</Badge>;
  }
}

export function AgentJobsPage(): JSX.Element {
  const { data, loading, refresh } = useQuery<JobsResponse>('/api/agents/jobs', { pollMs: 3000 });
  const mutation = useMutation();
  const toast = useToast();

  const cancel = async (job: AgentJob) => {
    const result = await mutation.run<{ ok: boolean; stopping: boolean }>(
      `/api/agents/jobs/${job.id}/cancel`,
    );
    if (result) {
      toast.push(
        result.stopping
          ? 'The agent will stop at its next batch and keep its place'
          : 'Job removed from the queue',
        'success',
      );
      refresh();
    } else if (mutation.error) {
      toast.push(mutation.error, 'error');
    }
  };

  const active = data?.active ?? [];
  const queued = data?.queued ?? [];
  const stalled = active.filter((job) => (job.silentForMs ?? 0) > SILENT_WARNING_MS);
  const waitingTooLong = queued.filter(
    (job) => (job.queuedForMs ?? 0) > (data?.claimTimeoutSeconds ?? 1800) * 500,
  );

  return (
    <>
      <PageHeader
        title="Agent jobs"
        subtitle="Scanning and hashing run on the Windows host; this is what it is doing"
      />
      <div className="content">
        {loading && !data && <Loading />}

        {stalled.length > 0 && (
          <Banner tone="critical" title="An agent has gone quiet mid-job">
            {stalled.map((job) => job.rootName).join(', ')} — no batch for over two minutes. The job
            is requeued automatically after five minutes with its place kept, but if the host is
            down nothing will pick it up.
          </Banner>
        )}

        {waitingTooLong.length > 0 && stalled.length === 0 && (
          <Banner tone="warning" title="Nothing has taken this work">
            {waitingTooLong.map((job) => job.rootName).join(', ')} has been queued a while. Check the
            agent is running on the host; it is given{' '}
            {formatDurationMs((data?.claimTimeoutSeconds ?? 1800) * 1000)} before the scan gives up.
          </Banner>
        )}

        <Card
          flush
          title="Running now"
          description={active.length === 0 ? undefined : `${active.length} job(s) in flight`}
        >
          {active.length === 0 ? (
            <EmptyState title="Nothing running">
              Work appears here when a catalog scan or bit-rot pass starts, either on schedule or
              from the Workflows page.
            </EmptyState>
          ) : (
            <div className="stack" style={{ padding: 16 }}>
              {active.map((job) => (
                <div key={job.id} className="rule-row">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                      <strong>{job.rootName}</strong>
                      <StateBadge job={job} />
                      <span className="faint" style={{ fontSize: 12 }}>
                        {TYPE_LABEL[job.type]}
                        {job.claimedBy ? ` · ${job.claimedBy}` : ''}
                      </span>
                    </div>
                    <div className="faint mono" style={{ fontSize: 12 }}>
                      {job.hostPath}
                    </div>

                    <ProgressBar
                      progress={{
                        done: job.dirsDone,
                        total: job.dirsRemaining > 0 ? job.dirsDone + job.dirsRemaining : null,
                        unit: 'directories',
                        message: `${formatCount(job.filesSeen)} files · ${formatBytes(job.bytesSeen)}`,
                        bytes: job.bytesSeen,
                      }}
                      indeterminate={job.dirsRemaining === 0}
                    />

                    <div className="faint" style={{ fontSize: 12 }}>
                      {formatDurationMs(job.elapsedMs)} elapsed
                      {job.filesPerSecond !== null &&
                        ` · ${formatCount(Math.round(job.filesPerSecond))} files/s`}
                      {job.silentForMs !== null && job.silentForMs > 30_000 &&
                        ` · quiet for ${formatDurationMs(job.silentForMs)}`}
                    </div>
                  </div>
                  <button
                    className="small danger"
                    disabled={mutation.busy || job.cancelRequested}
                    onClick={() => void cancel(job)}
                  >
                    {job.cancelRequested ? 'Stopping' : 'Stop'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>

        {queued.length > 0 && (
          <Card flush title="Waiting for an agent">
            <Table headers={['Root', 'Work', 'Queued', '']}>
              {queued.map((job) => (
                <tr key={job.id}>
                  <td>
                    <strong>{job.rootName}</strong>
                    <div className="faint mono" style={{ fontSize: 12 }}>
                      {job.hostPath}
                    </div>
                  </td>
                  <td>{TYPE_LABEL[job.type]}</td>
                  <td>{formatDurationMs(job.queuedForMs ?? 0)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="small" disabled={mutation.busy} onClick={() => void cancel(job)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        <Card flush title="Recent">
          {(data?.recent.length ?? 0) === 0 ? (
            <EmptyState title="No finished jobs yet" />
          ) : (
            <Table headers={['Root', 'Work', 'Outcome', '#Files', '#Size', 'Took', 'Finished']}>
              {(data?.recent ?? []).map((job) => (
                <tr key={job.id}>
                  <td>{job.rootName}</td>
                  <td>{TYPE_LABEL[job.type]}</td>
                  <td>
                    <StateBadge job={job} />
                    {job.error && (
                      <div className="faint" style={{ fontSize: 12 }}>
                        {job.error}
                      </div>
                    )}
                  </td>
                  <td className="num">{formatCount(job.filesSeen)}</td>
                  <td className="num">{job.bytesSeen > 0 ? formatBytes(job.bytesSeen) : '—'}</td>
                  <td className="num">{formatDurationMs(job.elapsedMs)}</td>
                  <td>{job.finishedAt ? formatRelative(job.finishedAt) : '—'}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
