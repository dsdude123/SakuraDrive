import { formatDurationMs, formatRelative, type WorkflowRun, type WorkflowStatus } from '@sakuradrive/shared';
import { PageHeader } from '../components/Layout.js';
import { ProgressBar } from '../components/ProgressBar.js';
import { Badge, Banner, Card, EmptyState, Loading, Table } from '../components/ui.js';
import { useMutation, useQuery } from '../hooks/useApi.js';
import { useToast } from '../hooks/useToast.js';
import { WorkflowStateBadge, formatMinutes } from './Dashboard.js';

export function WorkflowsPage(): JSX.Element {
  const { data, loading, refresh } = useQuery<{ workflows: WorkflowStatus[]; windowOpen: boolean }>(
    '/api/workflows',
    { pollMs: 3000 },
  );
  const runs = useQuery<{ runs: WorkflowRun[] }>('/api/workflows/runs', {
    query: { limit: 25 },
    pollMs: 10_000,
  });
  const mutation = useMutation();
  const toast = useToast();

  const start = async (workflow: WorkflowStatus) => {
    const result = await mutation.run(`/api/workflows/${workflow.id}/start`, {
      body: { force: true },
    });
    if (result) {
      toast.push(`${workflow.name} started`, 'success');
      refresh();
    } else if (mutation.error) {
      toast.push(mutation.error, 'error');
    }
  };

  const stop = async (workflow: WorkflowStatus) => {
    const result = await mutation.run(`/api/workflows/${workflow.id}/stop`);
    if (result) {
      toast.push(`${workflow.name} asked to stop — it will save its place and pause`, 'success');
      refresh();
    } else if (mutation.error) {
      toast.push(mutation.error, 'error');
    }
  };

  return (
    <>
      <PageHeader
        title="Workflows"
        subtitle="Every feature runs as a workflow: start one on demand, or let the schedule run it"
        actions={
          data && (
            <Badge tone={data.windowOpen ? 'ok' : 'neutral'} dot>
              {data.windowOpen ? 'I/O window open' : 'Outside I/O window'}
            </Badge>
          )
        }
      />
      <div className="content">
        {loading && !data && <Loading />}

        {data && !data.windowOpen && (
          <Banner tone="info" title="Heavy I/O is paused">
            Cataloguing and hashing only run inside the hours painted on the{' '}
            <a href="/schedule">schedule</a>. "Run now" starts them anyway and they will keep
            running until they finish or you stop them.
          </Banner>
        )}

        <div className="grid cols-2">
          {data?.workflows.map((workflow) => {
            const run = workflow.currentRun;
            const running = run?.state === 'running';
            const paused = run?.state === 'paused';
            return (
              <Card
                key={workflow.id}
                title={workflow.name}
                description={workflow.description}
                actions={
                  <>
                    <WorkflowStateBadge workflow={workflow} />
                    {running ? (
                      <button className="danger small" onClick={() => void stop(workflow)}>
                        Stop
                      </button>
                    ) : (
                      <button className="primary small" onClick={() => void start(workflow)}>
                        {paused ? 'Resume now' : 'Run now'}
                      </button>
                    )}
                  </>
                }
              >
                <div className="stack">
                  {running && run && (
                    <ProgressBar progress={run.progress} indeterminate={run.progress.total === null} />
                  )}

                  {paused && run && (
                    <Banner tone="warning" title="Paused with work remaining">
                      {run.progress.message || 'This run saved its place and will resume when the next window opens.'}
                    </Banner>
                  )}

                  <dl className="kv">
                    <dt>Schedule</dt>
                    <dd>
                      {workflow.respectsSchedule
                        ? workflow.windowOpen
                          ? `Window open${
                              workflow.minutesUntilWindow !== null
                                ? `, closes in ${formatMinutes(workflow.minutesUntilWindow)}`
                                : ''
                            }`
                          : workflow.minutesUntilWindow !== null
                            ? `Opens in ${formatMinutes(workflow.minutesUntilWindow)}`
                            : 'No window painted — on demand only'
                        : 'Runs independently of the I/O window'}
                    </dd>
                    <dt>Last run</dt>
                    <dd>
                      {workflow.lastRun ? (
                        <>
                          {formatRelative(workflow.lastRun.finishedAt)}{' '}
                          <Badge tone={workflow.lastRun.state === 'completed' ? 'ok' : 'critical'}>
                            {workflow.lastRun.state}
                          </Badge>
                        </>
                      ) : (
                        <span className="faint">never</span>
                      )}
                    </dd>
                    {workflow.lastRun && Object.keys(workflow.lastRun.stats).length > 0 && (
                      <>
                        <dt>Result</dt>
                        <dd>
                          {Object.entries(workflow.lastRun.stats)
                            .map(([key, value]) => `${humanise(key)}: ${value.toLocaleString()}`)
                            .join(' · ')}
                        </dd>
                      </>
                    )}
                    {workflow.lastRun?.error && (
                      <>
                        <dt>Error</dt>
                        <dd style={{ color: 'var(--critical)' }}>{workflow.lastRun.error}</dd>
                      </>
                    )}
                  </dl>

                  {(run?.logTail.length ?? 0) > 0 && (
                    <details>
                      <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                        Recent log
                      </summary>
                      <pre
                        className="mono"
                        style={{
                          fontSize: 11,
                          maxHeight: 200,
                          overflow: 'auto',
                          background: 'var(--bg-input)',
                          padding: 10,
                          borderRadius: 6,
                          margin: '8px 0 0',
                        }}
                      >
                        {run!.logTail.slice(-30).join('\n')}
                      </pre>
                    </details>
                  )}
                </div>
              </Card>
            );
          })}
        </div>

        <Card flush title="Run history">
          {(runs.data?.runs.length ?? 0) === 0 ? (
            <EmptyState title="Nothing has run yet" />
          ) : (
            <Table headers={['Workflow', 'State', 'Trigger', 'Started', '#Duration', 'Result']}>
              {runs.data!.runs.map((run) => (
                <tr key={run.id}>
                  <td>{run.workflowId}</td>
                  <td>
                    <Badge
                      tone={
                        run.state === 'completed'
                          ? 'ok'
                          : run.state === 'failed'
                            ? 'critical'
                            : run.state === 'running'
                              ? 'accent'
                              : 'neutral'
                      }
                    >
                      {run.state}
                    </Badge>
                  </td>
                  <td className="muted">{run.trigger}</td>
                  <td className="nowrap muted">{formatRelative(run.startedAt)}</td>
                  <td className="num">
                    {run.startedAt && run.finishedAt
                      ? formatDurationMs(Date.parse(run.finishedAt) - Date.parse(run.startedAt))
                      : '—'}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {run.error ?? Object.entries(run.stats)
                      .map(([key, value]) => `${humanise(key)} ${value.toLocaleString()}`)
                      .join(', ') ?? ''}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

/** `filesHashed` -> `Files hashed`. */
export function humanise(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
