import { useEffect, useState } from 'react';
import {
  SECRET_PLACEHOLDER,
  formatBytes,
  formatCount,
  formatRelative,
  type AgentSummary,
  type AgentToken,
  type BackupExpectation,
  type DuplicationRuleSetting,
  type ExportDestination,
  type ExportRecord,
  type ScanRoot,
  type Settings,
} from '@sakuradrive/shared';
import { api, upload } from '../api/client.js';
import { PageHeader } from '../components/Layout.js';
import { Badge, Banner, Card, Checkbox, EmptyState, Field, Loading, Table } from '../components/ui.js';
import { useMutation, useQuery } from '../hooks/useApi.js';
import { useToast } from '../hooks/useToast.js';

interface SettingsResponse {
  settings: Settings;
  timezones: string[];
}

type Tab = 'general' | 'roots' | 'duplication' | 'smart' | 'notifications' | 'backup' | 'export' | 'agents';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'roots', label: 'Catalog roots' },
  { id: 'duplication', label: 'Duplication' },
  { id: 'smart', label: 'Thresholds' },
  { id: 'notifications', label: 'Discord' },
  { id: 'backup', label: 'Backup' },
  { id: 'export', label: 'Backup & export' },
  { id: 'agents', label: 'Agents' },
];

/** A local id that will not collide with anything the server generated. */
function newLocalId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}

export function SettingsPage(): JSX.Element {
  const { data, loading, refresh } = useQuery<SettingsResponse>('/api/settings');
  const [tab, setTab] = useState<Tab>('general');
  const [draft, setDraft] = useState<Settings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (data) {
      setDraft(structuredClone(data.settings));
      setDirty(false);
    }
  }, [data]);

  if (loading && !data) return <Loading />;
  if (!draft || !data) return <Loading />;

  const patch = (updater: (next: Settings) => void) => {
    const next = structuredClone(draft);
    updater(next);
    setDraft(next);
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api('/api/settings', { method: 'PATCH', body: draft });
      toast.push('Settings saved', 'success');
      setDirty(false);
      refresh();
    } catch (error) {
      toast.push(error instanceof Error ? error.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Everything is configured here — the container only needs a data volume and the pool mounts"
        actions={
          <button className="primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving && <span className="spinner" />}
            Save changes
          </button>
        }
      />
      <div className="content">
        <div className="tabs">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              className={tab === entry.id ? 'tab active' : 'tab'}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {dirty && (
          <Banner tone="warning">
            You have unsaved changes. Nothing is applied until you press “Save changes”.
          </Banner>
        )}

        {tab === 'general' && <GeneralTab draft={draft} patch={patch} timezones={data.timezones} />}
        {tab === 'roots' && <RootsTab draft={draft} patch={patch} />}
        {tab === 'duplication' && <DuplicationTab draft={draft} patch={patch} />}
        {tab === 'smart' && <ThresholdsTab draft={draft} patch={patch} />}
        {tab === 'notifications' && <DiscordTab draft={draft} patch={patch} />}
        {tab === 'backup' && <BackupTab draft={draft} patch={patch} />}
        {tab === 'export' && <ExportTab draft={draft} patch={patch} onImported={refresh} />}
        {tab === 'agents' && <AgentsTab />}
      </div>
    </>
  );
}

type PatchFn = (updater: (next: Settings) => void) => void;

/* ------------------------------------------------------------------ general */

function GeneralTab({
  draft,
  patch,
  timezones,
}: {
  draft: Settings;
  patch: PatchFn;
  timezones: string[];
}): JSX.Element {
  return (
    <Card title="General">
      <div className="form-grid">
        <Field label="Site name" help="Shown in the sidebar and in Discord notifications.">
          <input
            type="text"
            value={draft.general.siteName}
            onChange={(event) => patch((next) => { next.general.siteName = event.target.value; })}
          />
        </Field>
        <Field
          label="Timezone"
          help="Every schedule decision and every timestamp in the interface uses this. The container itself normally runs in UTC."
        >
          <select
            value={draft.general.timezone}
            onChange={(event) => patch((next) => { next.general.timezone = event.target.value; })}
          >
            {timezones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Keep SMART history for (days)">
          <input
            type="number"
            min={1}
            value={draft.general.smartHistoryDays}
            onChange={(event) => patch((next) => { next.general.smartHistoryDays = Number(event.target.value); })}
          />
        </Field>
        <Field label="Keep performance samples for (days)">
          <input
            type="number"
            min={1}
            value={draft.general.performanceHistoryDays}
            onChange={(event) =>
              patch((next) => { next.general.performanceHistoryDays = Number(event.target.value); })
            }
          />
        </Field>
        <Field label="Keep resolved alerts for (days)">
          <input
            type="number"
            min={1}
            value={draft.general.alertHistoryDays}
            onChange={(event) => patch((next) => { next.general.alertHistoryDays = Number(event.target.value); })}
          />
        </Field>
        <Field label="Hash algorithm" help="sha256 is hardware accelerated on modern CPUs and is the sensible default.">
          <select
            value={draft.catalog.hashAlgorithm}
            onChange={(event) =>
              patch((next) => { next.catalog.hashAlgorithm = event.target.value as Settings['catalog']['hashAlgorithm']; })
            }
          >
            <option value="sha256">sha256</option>
            <option value="sha1">sha1</option>
            <option value="md5">md5</option>
            <option value="blake2b512">blake2b512</option>
          </select>
        </Field>
        <Field
          label="Re-verify each file after (days)"
          help="Bit rot leaves size and timestamp untouched, so this interval is the only thing that schedules a file to be read again. 0 disables re-verification entirely."
        >
          <input
            type="number"
            min={0}
            value={draft.catalog.rehashIntervalDays}
            onChange={(event) => patch((next) => { next.catalog.rehashIntervalDays = Number(event.target.value); })}
          />
        </Field>
        <Field
          label="Mass-deletion alert threshold (%)"
          help="Raise a critical alert when one scan marks more than this share of a root as deleted — a dead disk and a missing bind mount look identical from inside the container."
        >
          <input
            type="number"
            min={0}
            max={100}
            value={draft.catalog.massDeletionAlertPercent}
            onChange={(event) =>
              patch((next) => { next.catalog.massDeletionAlertPercent = Number(event.target.value); })
            }
          />
        </Field>
      </div>

      <div className="stack" style={{ marginTop: 16 }}>
        <Checkbox
          label="Detect bit rot while hashing"
          help="Turning this off still records hashes; it just stops raising findings."
          checked={draft.bitrot.enabled}
          onChange={(value) => patch((next) => { next.bitrot.enabled = value; })}
        />
        <Checkbox
          label="Re-read a file before confirming a bit-rot finding"
          help="Distinguishes a genuine on-disk change from a one-off controller read fault."
          checked={draft.bitrot.verifyOnDetect}
          onChange={(value) => patch((next) => { next.bitrot.verifyOnDetect = value; })}
        />
        <Checkbox
          label="Require a password to use this interface"
          help="Turn off only on a trusted network. Agent tokens are always required regardless."
          checked={draft.security.requireLogin}
          onChange={(value) => patch((next) => { next.security.requireLogin = value; })}
        />
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------- roots */

function RootsTab({ draft, patch }: { draft: Settings; patch: PatchFn }): JSX.Element {
  const [checking, setChecking] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, { readable: boolean; hint?: string; entries: string[] }>>({});
  const orphaned = useQuery<{ roots: Array<{ rootId: string; stats: { files: number; bytes: number } }> }>(
    '/api/catalog/orphaned',
  );
  const mutation = useMutation();
  const toast = useToast();

  const purge = async (rootId: string) => {
    const result = await mutation.run(`/api/catalog/roots/${encodeURIComponent(rootId)}/data`, {
      method: 'DELETE',
    });
    if (result) {
      toast.push(`Purged the catalog of ${rootId}`, 'success');
      orphaned.refresh();
    } else if (mutation.error) {
      toast.push(mutation.error, 'error');
    }
  };

  const addRoot = () => {
    patch((next) => {
      next.catalog.roots.push({
        id: newLocalId('root'),
        name: 'New root',
        kind: 'pool',
        poolId: null,
        containerPath: '/mnt/pools/hdd',
        hostPath: 'P:\\',
        driveLabel: '',
        enabled: true,
        hashEnabled: true,
        includeGlobs: [],
        excludeGlobs: [],
        minHashSizeBytes: 0,
        maxHashSizeBytes: 0,
      });
    });
  };

  const check = async (root: ScanRoot) => {
    setChecking(root.id);
    try {
      const result = await api<{ readable: boolean; hint?: string; entries: string[] }>(
        '/api/settings/check-path',
        { query: { path: root.containerPath } },
      );
      setChecks((current) => ({ ...current, [root.id]: result }));
      toast.push(result.readable ? `${root.containerPath} is readable` : (result.hint ?? 'Not readable'),
        result.readable ? 'success' : 'error');
    } finally {
      setChecking(null);
    }
  };

  return (
    <div className="stack">
      <Banner tone="info" title="How roots map onto DrivePool">
        A <strong>pool</strong> root is the DrivePool virtual drive — the logical view of your data.
        A <strong>pool part</strong> root is one underlying disk&apos;s <code>PoolPart.*</code> folder;
        cataloguing those as well is what lets the disaster-recovery report say exactly which files a
        specific dead disk took with it. Give a pool and its parts the same pool id to link them.
      </Banner>

      {(orphaned.data?.roots.length ?? 0) > 0 && (
        <Card
          title="Catalog data from removed roots"
          description="Kept on purpose — a root deleted by accident must not take the record of what was on that disk with it"
        >
          <div className="stack">
            {orphaned.data!.roots.map((entry) => (
              <div key={entry.rootId} className="rule-row">
                <div>
                  <strong className="mono">{entry.rootId}</strong>
                  <div className="faint" style={{ fontSize: 12 }}>
                    {formatCount(entry.stats.files)} files · {formatBytes(entry.stats.bytes)} — still
                    searchable under Catalog, including files marked deleted.
                  </div>
                </div>
                <button className="small danger" onClick={() => void purge(entry.rootId)}>
                  Purge permanently
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {draft.catalog.roots.length === 0 && (
        <EmptyState title="No roots configured" action={<button className="primary" onClick={addRoot}>Add a root</button>}>
          Bind-mount your pool into the container (see docker-compose.yml) and add it here.
        </EmptyState>
      )}

      {draft.catalog.roots.map((root, index) => (
        <Card
          key={root.id}
          title={root.name || 'Root'}
          description={`${root.kind} · ${root.containerPath}`}
          actions={
            <>
              <button className="small" disabled={checking === root.id} onClick={() => void check(root)}>
                {checking === root.id && <span className="spinner" />}
                Check mount
              </button>
              <button
                className="small danger"
                onClick={() => patch((next) => { next.catalog.roots.splice(index, 1); })}
              >
                Remove
              </button>
            </>
          }
        >
          {checks[root.id] && (
            <Banner tone={checks[root.id]!.readable ? 'ok' : 'critical'}>
              {checks[root.id]!.readable
                ? `Readable — contains ${checks[root.id]!.entries.slice(0, 6).join(', ')}${
                    checks[root.id]!.entries.length > 6 ? '…' : ''
                  }`
                : checks[root.id]!.hint}
            </Banner>
          )}

          <div className="form-grid" style={{ marginTop: 12 }}>
            <Field label="Name">
              <input
                type="text"
                value={root.name}
                onChange={(event) => patch((next) => { next.catalog.roots[index]!.name = event.target.value; })}
              />
            </Field>
            <Field label="Kind">
              <select
                value={root.kind}
                onChange={(event) =>
                  patch((next) => { next.catalog.roots[index]!.kind = event.target.value as ScanRoot['kind']; })
                }
              >
                <option value="pool">Pool (DrivePool virtual drive)</option>
                <option value="poolpart">Pool part (one disk&apos;s PoolPart folder)</option>
                <option value="disk">Standalone disk</option>
              </select>
            </Field>
            <Field label="Pool id" help="Links a pool root with its part roots. Anything consistent works.">
              <input
                type="text"
                value={root.poolId ?? ''}
                onChange={(event) =>
                  patch((next) => { next.catalog.roots[index]!.poolId = event.target.value || null; })
                }
              />
            </Field>
            <Field label="Path inside the container" help="The bind mount target, e.g. /mnt/pools/hdd">
              <input
                type="text"
                value={root.containerPath}
                onChange={(event) =>
                  patch((next) => { next.catalog.roots[index]!.containerPath = event.target.value; })
                }
              />
            </Field>
            <Field label="Windows path" help="Shown in alerts and reports so paths are actionable on the host.">
              <input
                type="text"
                value={root.hostPath}
                onChange={(event) => patch((next) => { next.catalog.roots[index]!.hostPath = event.target.value; })}
              />
            </Field>
            <Field label="Drive label" help="The label you wrote on the caddy, e.g. DRIVEPOOL27.">
              <input
                type="text"
                value={root.driveLabel}
                onChange={(event) => patch((next) => { next.catalog.roots[index]!.driveLabel = event.target.value; })}
              />
            </Field>
            <Field label="Exclude globs (one per line)">
              <textarea
                value={root.excludeGlobs.join('\n')}
                onChange={(event) =>
                  patch((next) => {
                    next.catalog.roots[index]!.excludeGlobs = event.target.value
                      .split('\n')
                      .map((line) => line.trim())
                      .filter(Boolean);
                  })
                }
              />
            </Field>
            <Field label="Include globs (blank = everything)">
              <textarea
                value={root.includeGlobs.join('\n')}
                onChange={(event) =>
                  patch((next) => {
                    next.catalog.roots[index]!.includeGlobs = event.target.value
                      .split('\n')
                      .map((line) => line.trim())
                      .filter(Boolean);
                  })
                }
              />
            </Field>
          </div>

          <div className="stack" style={{ marginTop: 12 }}>
            <Checkbox
              label="Scan this root"
              checked={root.enabled}
              onChange={(value) => patch((next) => { next.catalog.roots[index]!.enabled = value; })}
            />
            <Checkbox
              label="Hash files in this root"
              help="Turn off for scratch space where bit-rot detection is not worth the I/O."
              checked={root.hashEnabled}
              onChange={(value) => patch((next) => { next.catalog.roots[index]!.hashEnabled = value; })}
            />
          </div>
        </Card>
      ))}

      {draft.catalog.roots.length > 0 && (
        <div>
          <button onClick={addRoot}>Add another root</button>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- duplication */

function DuplicationTab({ draft, patch }: { draft: Settings; patch: PatchFn }): JSX.Element {
  const addRule = () => {
    patch((next) => {
      next.duplication.rules.push({
        id: newLocalId('dup'),
        poolId: null,
        path: '',
        level: 2,
        source: 'manual',
        note: '',
      });
    });
  };

  const fromAgent = draft.duplication.rules.filter((rule) => rule.source === 'drivepool');
  const manual = draft.duplication.rules.filter((rule) => rule.source === 'manual');

  return (
    <div className="stack">
      <Banner tone="info" title="Where duplication levels come from">
        The Windows agent reads them straight from DrivePool with <code>dpcmd</code>, so normally
        there is nothing to enter here. Rules you add by hand override the agent&apos;s at the same
        depth, which is how you correct a bad reading or describe a pool the agent cannot reach.
        Resolution follows DrivePool: the deepest matching folder wins and descendants inherit.
      </Banner>

      <Card title="Defaults">
        <div className="form-grid">
          <Field label="Default duplication level" help="Applied to any path no rule matches.">
            <input
              type="number"
              min={1}
              max={10}
              value={draft.duplication.defaultLevel}
              onChange={(event) => patch((next) => { next.duplication.defaultLevel = Number(event.target.value); })}
            />
          </Field>
        </div>
        <div className="stack" style={{ marginTop: 12 }}>
          <Checkbox
            label="Accept duplication settings reported by the agent"
            checked={draft.duplication.acceptAgentRules}
            onChange={(value) => patch((next) => { next.duplication.acceptAgentRules = value; })}
          />
          <Checkbox
            label="Alert when a file has fewer copies than its rule requires"
            help="Needs pool-part roots so the real number of copies can be counted."
            checked={draft.duplication.alertOnUnderDuplication}
            onChange={(value) => patch((next) => { next.duplication.alertOnUnderDuplication = value; })}
          />
        </div>
      </Card>

      <Card
        flush
        title="Manual rules"
        description="Longest matching path wins; an empty path sets the pool default"
        actions={<button className="small" onClick={addRule}>Add rule</button>}
      >
        {manual.length === 0 ? (
          <EmptyState title="No manual rules" />
        ) : (
          <Table headers={['Pool id', 'Path', '#Level', 'Note', '']}>
            {manual.map((rule) => {
              const index = draft.duplication.rules.findIndex((entry) => entry.id === rule.id);
              return (
                <tr key={rule.id}>
                  <td>
                    <input
                      type="text"
                      value={rule.poolId ?? ''}
                      onChange={(event) =>
                        patch((next) => { next.duplication.rules[index]!.poolId = event.target.value || null; })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      placeholder="Media/Movies"
                      value={rule.path}
                      onChange={(event) => patch((next) => { next.duplication.rules[index]!.path = event.target.value; })}
                    />
                  </td>
                  <td className="num" style={{ width: 90 }}>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={rule.level}
                      onChange={(event) =>
                        patch((next) => { next.duplication.rules[index]!.level = Number(event.target.value); })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={rule.note}
                      onChange={(event) => patch((next) => { next.duplication.rules[index]!.note = event.target.value; })}
                    />
                  </td>
                  <td>
                    <button
                      className="small danger"
                      onClick={() => patch((next) => { next.duplication.rules.splice(index, 1); })}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Card flush title="Reported by DrivePool" description="Read-only — refreshed on every agent report">
        {fromAgent.length === 0 ? (
          <EmptyState title="The agent has not reported duplication settings yet" />
        ) : (
          <Table headers={['Pool id', 'Path', '#Level']}>
            {fromAgent.map((rule: DuplicationRuleSetting) => (
              <tr key={rule.id}>
                <td className="mono">{rule.poolId ?? '—'}</td>
                <td className="path">{rule.path || <span className="faint">(pool root)</span>}</td>
                <td className="num">
                  <Badge tone={rule.level > 1 ? 'accent' : 'neutral'}>{rule.level}×</Badge>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- thresholds */

function ThresholdsTab({ draft, patch }: { draft: Settings; patch: PatchFn }): JSX.Element {
  return (
    <div className="stack">
      <Card title="SMART and temperature">
        <div className="form-grid">
          <Field label="Temperature warning (°C)">
            <input
              type="number"
              value={draft.smart.temperatureWarnC}
              onChange={(event) => patch((next) => { next.smart.temperatureWarnC = Number(event.target.value); })}
            />
          </Field>
          <Field label="Temperature critical (°C)">
            <input
              type="number"
              value={draft.smart.temperatureCritC}
              onChange={(event) => patch((next) => { next.smart.temperatureCritC = Number(event.target.value); })}
            />
          </Field>
          <Field label="NVMe wear warning (%)">
            <input
              type="number"
              value={draft.smart.nvmeWearWarnPercent}
              onChange={(event) => patch((next) => { next.smart.nvmeWearWarnPercent = Number(event.target.value); })}
            />
          </Field>
          <Field label="NVMe wear critical (%)">
            <input
              type="number"
              value={draft.smart.nvmeWearCritPercent}
              onChange={(event) => patch((next) => { next.smart.nvmeWearCritPercent = Number(event.target.value); })}
            />
          </Field>
          <Field
            label="Agent considered stale after (minutes)"
            help="No report for this long raises an alert — SMART monitoring is blind while an agent is down."
          >
            <input
              type="number"
              min={5}
              value={draft.smart.agentStaleMinutes}
              onChange={(event) => patch((next) => { next.smart.agentStaleMinutes = Number(event.target.value); })}
            />
          </Field>
        </div>
      </Card>

      <Card
        title="Disk performance"
        description="The pattern behind “everything locked up”: latency that stays high across several samples"
      >
        <div className="form-grid">
          <Field label="Latency warning (ms)">
            <input
              type="number"
              value={draft.performance.latencyWarnMs}
              onChange={(event) => patch((next) => { next.performance.latencyWarnMs = Number(event.target.value); })}
            />
          </Field>
          <Field label="Latency critical (ms)">
            <input
              type="number"
              value={draft.performance.latencyCritMs}
              onChange={(event) => patch((next) => { next.performance.latencyCritMs = Number(event.target.value); })}
            />
          </Field>
          <Field label="Queue length warning">
            <input
              type="number"
              value={draft.performance.queueWarn}
              onChange={(event) => patch((next) => { next.performance.queueWarn = Number(event.target.value); })}
            />
          </Field>
          <Field label="Queue length critical">
            <input
              type="number"
              value={draft.performance.queueCrit}
              onChange={(event) => patch((next) => { next.performance.queueCrit = Number(event.target.value); })}
            />
          </Field>
          <Field
            label="Consecutive bad samples before alerting"
            help="A single slow sample during a scrub is normal; a run of them is not."
          >
            <input
              type="number"
              min={1}
              max={20}
              value={draft.performance.consecutiveSamples}
              onChange={(event) =>
                patch((next) => { next.performance.consecutiveSamples = Number(event.target.value); })
              }
            />
          </Field>
        </div>
        <div style={{ marginTop: 12 }}>
          <Checkbox
            label="Monitor disk performance"
            checked={draft.performance.enabled}
            onChange={(value) => patch((next) => { next.performance.enabled = value; })}
          />
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ discord */

function DiscordTab({ draft, patch }: { draft: Settings; patch: PatchFn }): JSX.Element {
  const mutation = useMutation();
  const toast = useToast();

  const test = async () => {
    const result = await mutation.run<{ ok: boolean; error?: string }>('/api/settings/test-discord', {
      body: { webhookUrl: draft.notifications.discord.webhookUrl, username: draft.notifications.discord.username },
    });
    if (result?.ok) toast.push('Test message sent — check the channel', 'success');
    else toast.push(result?.error ?? mutation.error ?? 'Test failed', 'error');
  };

  return (
    <Card
      title="Discord notifications"
      actions={
        <button className="small" disabled={mutation.busy} onClick={() => void test()}>
          {mutation.busy && <span className="spinner" />}
          Send test message
        </button>
      }
    >
      <div className="form-grid">
        <Field
          label="Webhook URL"
          help="Channel settings → Integrations → Webhooks. Stored server-side and masked here once saved."
        >
          <input
            type="text"
            value={draft.notifications.discord.webhookUrl}
            placeholder="https://discord.com/api/webhooks/…"
            onChange={(event) =>
              patch((next) => { next.notifications.discord.webhookUrl = event.target.value; })
            }
          />
        </Field>
        <Field label="Bot username">
          <input
            type="text"
            value={draft.notifications.discord.username}
            onChange={(event) => patch((next) => { next.notifications.discord.username = event.target.value; })}
          />
        </Field>
        <Field label="Minimum severity">
          <select
            value={draft.notifications.discord.minSeverity}
            onChange={(event) =>
              patch((next) => {
                next.notifications.discord.minSeverity = event.target.value as 'info' | 'warning' | 'critical';
              })
            }
          >
            <option value="info">Everything, including info</option>
            <option value="warning">Warnings and above</option>
            <option value="critical">Critical only</option>
          </select>
        </Field>
        <Field label="Mention on critical" help="Pasted verbatim, e.g. &lt;@&amp;123456789&gt; for a role.">
          <input
            type="text"
            value={draft.notifications.discord.mentionOnCritical}
            onChange={(event) =>
              patch((next) => { next.notifications.discord.mentionOnCritical = event.target.value; })
            }
          />
        </Field>
        <Field
          label="Batch window (seconds)"
          help="Alerts raised within this window are collapsed into one message. A controller dropping eight drives should not produce eight pings."
        >
          <input
            type="number"
            min={0}
            max={3600}
            value={draft.notifications.discord.batchWindowSeconds}
            onChange={(event) =>
              patch((next) => { next.notifications.discord.batchWindowSeconds = Number(event.target.value); })
            }
          />
        </Field>
        <Field
          label="Repeat an ongoing alert after (hours)"
          help="0 means never repeat. A condition that gets worse always notifies again immediately."
        >
          <input
            type="number"
            min={0}
            value={draft.notifications.discord.renotifyAfterHours}
            onChange={(event) =>
              patch((next) => { next.notifications.discord.renotifyAfterHours = Number(event.target.value); })
            }
          />
        </Field>
      </div>

      <div className="stack" style={{ marginTop: 16 }}>
        <Checkbox
          label="Send Discord notifications"
          checked={draft.notifications.discord.enabled}
          onChange={(value) => patch((next) => { next.notifications.discord.enabled = value; })}
        />
        <Checkbox
          label="Announce when an alert clears"
          checked={draft.notifications.discord.notifyOnResolved}
          onChange={(value) => patch((next) => { next.notifications.discord.notifyOnResolved = value; })}
        />
        <Checkbox
          label="Notify when a workflow fails"
          help="A scan that quietly stopped running is how a catalog goes stale without anyone noticing."
          checked={draft.notifications.discord.notifyOnWorkflowFailure}
          onChange={(value) =>
            patch((next) => { next.notifications.discord.notifyOnWorkflowFailure = value; })
          }
        />
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------- backup */

function BackupTab({ draft, patch }: { draft: Settings; patch: PatchFn }): JSX.Element {
  const mutation = useMutation();
  const toast = useToast();
  const [sources, setSources] = useState<string[]>([]);

  const test = async () => {
    const result = await mutation.run<{ ok: boolean; message?: string; version?: string; sources?: string[] }>(
      '/api/settings/test-kopia',
    );
    if (result?.ok) {
      setSources(result.sources ?? []);
      toast.push(`${result.version ?? 'Kopia'} — ${result.message}`, 'success');
    } else {
      toast.push(result?.message ?? mutation.error ?? 'Kopia test failed', 'error');
    }
  };

  const addExpectation = () => {
    patch((next) => {
      next.backup.expectations.push({
        id: newLocalId('exp'),
        name: 'New expectation',
        enabled: true,
        rootId: next.catalog.roots[0]?.id ?? '',
        includeGlobs: [],
        excludeGlobs: [],
        kopiaSource: '',
        kopiaPathPrefix: '',
        minFileSizeBytes: 0,
        maxSnapshotAgeHours: 192,
      });
    });
  };

  return (
    <div className="stack">
      <Card
        title="Kopia repository"
        actions={
          <button className="small" disabled={mutation.busy} onClick={() => void test()}>
            {mutation.busy && <span className="spinner" />}
            Test connection
          </button>
        }
      >
        <div className="form-grid">
          <Field label="Mode">
            <select
              value={draft.backup.mode}
              onChange={(event) =>
                patch((next) => { next.backup.mode = event.target.value as Settings['backup']['mode']; })
              }
            >
              <option value="disabled">Disabled</option>
              <option value="kopia">Query the repository with the Kopia CLI</option>
              <option value="manifest">Read a listing file</option>
            </select>
          </Field>
          {draft.backup.mode === 'manifest' && (
            <Field
              label="Manifest path"
              help="A file inside the container: NDJSON, tab-separated size/mtime/path, or one path per line."
            >
              <input
                type="text"
                value={draft.backup.manifestPath}
                onChange={(event) => patch((next) => { next.backup.manifestPath = event.target.value; })}
              />
            </Field>
          )}
          {draft.backup.mode === 'kopia' && (
            <>
              <Field label="Repository type">
                <select
                  value={draft.backup.repository.type}
                  onChange={(event) =>
                    patch((next) => {
                      next.backup.repository.type = event.target
                        .value as Settings['backup']['repository']['type'];
                    })
                  }
                >
                  <option value="b2">Backblaze B2</option>
                  <option value="s3">S3-compatible</option>
                  <option value="filesystem">Local filesystem</option>
                  <option value="existing">Already connected</option>
                </select>
              </Field>
              {draft.backup.repository.type === 'filesystem' ? (
                <Field label="Repository path">
                  <input
                    type="text"
                    value={draft.backup.repository.path}
                    onChange={(event) => patch((next) => { next.backup.repository.path = event.target.value; })}
                  />
                </Field>
              ) : (
                <>
                  <Field label="Bucket">
                    <input
                      type="text"
                      value={draft.backup.repository.bucket}
                      onChange={(event) => patch((next) => { next.backup.repository.bucket = event.target.value; })}
                    />
                  </Field>
                  <Field label="Prefix">
                    <input
                      type="text"
                      value={draft.backup.repository.prefix}
                      onChange={(event) => patch((next) => { next.backup.repository.prefix = event.target.value; })}
                    />
                  </Field>
                  <Field label="Key ID">
                    <input
                      type="text"
                      value={draft.backup.repository.keyId}
                      onChange={(event) => patch((next) => { next.backup.repository.keyId = event.target.value; })}
                    />
                  </Field>
                  <Field label="Application key">
                    <input
                      type="password"
                      value={draft.backup.repository.key}
                      onChange={(event) => patch((next) => { next.backup.repository.key = event.target.value; })}
                    />
                  </Field>
                </>
              )}
              <Field label="Repository password">
                <input
                  type="password"
                  value={draft.backup.password}
                  onChange={(event) => patch((next) => { next.backup.password = event.target.value; })}
                />
              </Field>
              <Field label="Verify every (hours)">
                <input
                  type="number"
                  min={1}
                  value={draft.backup.verifyIntervalHours}
                  onChange={(event) =>
                    patch((next) => { next.backup.verifyIntervalHours = Number(event.target.value); })
                  }
                />
              </Field>
            </>
          )}
        </div>
        <div style={{ marginTop: 12 }}>
          <Checkbox
            label="Verify backup coverage"
            checked={draft.backup.enabled}
            onChange={(value) => patch((next) => { next.backup.enabled = value; })}
          />
        </div>
        {sources.length > 0 && (
          <Banner tone="ok" title="Snapshot sources found">
            <div className="chip-list" style={{ marginTop: 6 }}>
              {sources.map((source) => (
                <Badge key={source}>{source}</Badge>
              ))}
            </div>
          </Banner>
        )}
        {draft.backup.password === SECRET_PLACEHOLDER && (
          <p className="faint" style={{ fontSize: 12 }}>
            Credentials are masked once saved. Leaving the mask in place keeps the stored value.
          </p>
        )}
      </Card>

      <Card
        title="What is expected to be backed up"
        description="Not everything on the pool needs the Backblaze treatment — only these rules define what counts"
        actions={<button className="small" onClick={addExpectation}>Add expectation</button>}
      >
        {draft.backup.expectations.length === 0 ? (
          <EmptyState title="No expectations defined">
            Until you add one, nothing is expected to be backed up and no gaps are reported.
          </EmptyState>
        ) : (
          <div className="stack">
            {draft.backup.expectations.map((expectation: BackupExpectation, index) => (
              <div key={expectation.id} className="rule-row">
                <div className="form-grid">
                  <Field label="Name">
                    <input
                      type="text"
                      value={expectation.name}
                      onChange={(event) =>
                        patch((next) => { next.backup.expectations[index]!.name = event.target.value; })
                      }
                    />
                  </Field>
                  <Field label="Catalog root">
                    <select
                      value={expectation.rootId}
                      onChange={(event) =>
                        patch((next) => { next.backup.expectations[index]!.rootId = event.target.value; })
                      }
                    >
                      {draft.catalog.roots.map((root) => (
                        <option key={root.id} value={root.id}>
                          {root.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Kopia source" help="As shown by `kopia snapshot list`, e.g. backup@NAS-01:P:\Media">
                    <input
                      type="text"
                      value={expectation.kopiaSource}
                      onChange={(event) =>
                        patch((next) => { next.backup.expectations[index]!.kopiaSource = event.target.value; })
                      }
                    />
                  </Field>
                  <Field
                    label="Catalog path prefix"
                    help="Strip this from catalog paths to get the path inside the snapshot. Leave blank when the snapshot root is the catalog root."
                  >
                    <input
                      type="text"
                      value={expectation.kopiaPathPrefix}
                      onChange={(event) =>
                        patch((next) => { next.backup.expectations[index]!.kopiaPathPrefix = event.target.value; })
                      }
                    />
                  </Field>
                  <Field label="Include globs (blank = everything under the prefix)">
                    <textarea
                      value={expectation.includeGlobs.join('\n')}
                      onChange={(event) =>
                        patch((next) => {
                          next.backup.expectations[index]!.includeGlobs = event.target.value
                            .split('\n')
                            .map((line) => line.trim())
                            .filter(Boolean);
                        })
                      }
                    />
                  </Field>
                  <Field label="Exclude globs">
                    <textarea
                      value={expectation.excludeGlobs.join('\n')}
                      onChange={(event) =>
                        patch((next) => {
                          next.backup.expectations[index]!.excludeGlobs = event.target.value
                            .split('\n')
                            .map((line) => line.trim())
                            .filter(Boolean);
                        })
                      }
                    />
                  </Field>
                  <Field label="Ignore files smaller than (bytes)">
                    <input
                      type="number"
                      min={0}
                      value={expectation.minFileSizeBytes}
                      onChange={(event) =>
                        patch((next) => {
                          next.backup.expectations[index]!.minFileSizeBytes = Number(event.target.value);
                        })
                      }
                    />
                  </Field>
                  <Field label="Warn when the newest snapshot is older than (hours)">
                    <input
                      type="number"
                      min={0}
                      value={expectation.maxSnapshotAgeHours}
                      onChange={(event) =>
                        patch((next) => {
                          next.backup.expectations[index]!.maxSnapshotAgeHours = Number(event.target.value);
                        })
                      }
                    />
                  </Field>
                </div>
                <div className="stack">
                  <Checkbox
                    label="Enabled"
                    checked={expectation.enabled}
                    onChange={(value) =>
                      patch((next) => { next.backup.expectations[index]!.enabled = value; })
                    }
                  />
                  <button
                    className="small danger"
                    onClick={() => patch((next) => { next.backup.expectations.splice(index, 1); })}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------- export */

function ExportTab({
  draft,
  patch,
  onImported,
}: {
  draft: Settings;
  patch: PatchFn;
  onImported: () => void;
}): JSX.Element {
  const exports = useQuery<{ exports: ExportRecord[]; lastExportAt: string | null }>('/api/exports', {
    pollMs: 30_000,
  });
  const destinations = useQuery<{ destinations: Array<{ id: string; name: string; path: string; writable: boolean; error: string | null }> }>(
    '/api/export/destinations/check',
  );
  const mutation = useMutation();
  const toast = useToast();
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [importSettings, setImportSettings] = useState(false);
  const [importing, setImporting] = useState(false);

  const addDestination = () => {
    patch((next) => {
      next.autoExport.destinations.push({
        id: newLocalId('dest'),
        name: 'Backblaze-backed folder',
        path: '/backup/sakuradrive',
        enabled: true,
        retain: 14,
      });
    });
  };

  const createNow = async () => {
    const result = await mutation.run<{ downloadUrl: string; recordCount: number; sizeBytes: number }>(
      '/api/export/create',
      { body: {} },
    );
    if (result) {
      toast.push(`Bundle ready: ${result.recordCount.toLocaleString()} records`, 'success');
      window.location.href = result.downloadUrl;
      exports.refresh();
    } else if (mutation.error) {
      toast.push(mutation.error, 'error');
    }
  };

  const runScheduled = async () => {
    const result = await mutation.run('/api/export/run-now');
    if (result) toast.push('Export workflow started', 'success');
    else if (mutation.error) toast.push(mutation.error, 'error');
  };

  const doImport = async (file: File) => {
    setImporting(true);
    try {
      const result = await upload<{ imported: Record<string, number>; warnings: string[] }>(
        '/api/export/import',
        file,
        { mode: importMode, importSettings },
      );
      const total = Object.values(result.imported).reduce((sum, value) => sum + value, 0);
      toast.push(`Imported ${total.toLocaleString()} records`, 'success');
      if (result.warnings.length > 0) toast.push(`${result.warnings.length} warnings`, 'error');
      onImported();
    } catch (error) {
      toast.push(error instanceof Error ? error.message : 'Import failed', 'error');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="stack">
      <Banner tone="info" title="Why this matters more than it looks">
        The catalog is most valuable immediately after a disk failure — which is exactly the moment
        this container&apos;s own storage might be gone too. Bundles are written to a directory outside
        the app&apos;s data volume, verified by reading them back, and old ones pruned.
      </Banner>

      <Card
        title="Automatic exports"
        actions={
          <>
            <button className="small" onClick={() => void runScheduled()} disabled={mutation.busy}>
              Run export now
            </button>
            <button className="small primary" onClick={() => void createNow()} disabled={mutation.busy}>
              Download a bundle
            </button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="Time of day" help="Local time in the configured timezone.">
            <input
              type="time"
              value={draft.autoExport.timeOfDay}
              onChange={(event) => patch((next) => { next.autoExport.timeOfDay = event.target.value; })}
            />
          </Field>
          <Field label="Days">
            <div className="chip-list">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((name, day) => (
                <button
                  key={name}
                  className={draft.autoExport.daysOfWeek.includes(day) ? 'primary small' : 'small'}
                  onClick={() =>
                    patch((next) => {
                      const set = new Set(next.autoExport.daysOfWeek);
                      if (set.has(day)) set.delete(day);
                      else set.add(day);
                      next.autoExport.daysOfWeek = [...set].sort();
                    })
                  }
                >
                  {name}
                </button>
              ))}
            </div>
          </Field>
        </div>

        <div className="stack" style={{ marginTop: 16 }}>
          <Checkbox
            label="Export automatically"
            checked={draft.autoExport.enabled}
            onChange={(value) => patch((next) => { next.autoExport.enabled = value; })}
          />
          <Checkbox
            label="Include the file catalog"
            help="The bulk of the bundle, and the part that matters for recovery."
            checked={draft.autoExport.includeCatalog}
            onChange={(value) => patch((next) => { next.autoExport.includeCatalog = value; })}
          />
          <Checkbox
            label="Include SMART history"
            checked={draft.autoExport.includeSmartHistory}
            onChange={(value) => patch((next) => { next.autoExport.includeSmartHistory = value; })}
          />
          <Checkbox
            label="Replace credentials with placeholders"
            help="Recommended: the bundle is written outside the app and may end up in cloud storage."
            checked={draft.autoExport.redactSecrets}
            onChange={(value) => patch((next) => { next.autoExport.redactSecrets = value; })}
          />
          <Checkbox
            label="Verify each bundle after writing it"
            help="Reads the file back and compares the record count."
            checked={draft.autoExport.verifyAfterWrite}
            onChange={(value) => patch((next) => { next.autoExport.verifyAfterWrite = value; })}
          />
        </div>
      </Card>

      <Card
        title="Destinations"
        description="Directories inside the container — bind-mount somewhere the host already backs up"
        actions={<button className="small" onClick={addDestination}>Add destination</button>}
      >
        {draft.autoExport.destinations.length === 0 ? (
          <EmptyState title="No destinations configured">
            Without one, exports stay inside the container and would be lost with it.
          </EmptyState>
        ) : (
          <div className="stack">
            {draft.autoExport.destinations.map((destination: ExportDestination, index) => {
              const check = destinations.data?.destinations.find((entry) => entry.id === destination.id);
              return (
                <div key={destination.id} className="rule-row">
                  <div className="form-grid">
                    <Field label="Name">
                      <input
                        type="text"
                        value={destination.name}
                        onChange={(event) =>
                          patch((next) => { next.autoExport.destinations[index]!.name = event.target.value; })
                        }
                      />
                    </Field>
                    <Field
                      label="Path"
                      help={
                        check
                          ? check.writable
                            ? 'Writable ✓'
                            : `Not writable: ${check.error ?? 'unknown error'}`
                          : undefined
                      }
                    >
                      <input
                        type="text"
                        value={destination.path}
                        onChange={(event) =>
                          patch((next) => { next.autoExport.destinations[index]!.path = event.target.value; })
                        }
                      />
                    </Field>
                    <Field label="Keep this many bundles">
                      <input
                        type="number"
                        min={1}
                        max={365}
                        value={destination.retain}
                        onChange={(event) =>
                          patch((next) => {
                            next.autoExport.destinations[index]!.retain = Number(event.target.value);
                          })
                        }
                      />
                    </Field>
                  </div>
                  <div className="stack">
                    <Checkbox
                      label="Enabled"
                      checked={destination.enabled}
                      onChange={(value) =>
                        patch((next) => { next.autoExport.destinations[index]!.enabled = value; })
                      }
                    />
                    <button
                      className="small danger"
                      onClick={() => patch((next) => { next.autoExport.destinations.splice(index, 1); })}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Import a bundle" description="Restore into this install, or into a fresh one after a rebuild">
        <div className="form-grid">
          <Field
            label="Mode"
            help="Merge keeps rows already here and overwrites matching ones. Replace clears each table in the bundle first."
          >
            <select value={importMode} onChange={(event) => setImportMode(event.target.value as 'merge' | 'replace')}>
              <option value="merge">Merge</option>
              <option value="replace">Replace</option>
            </select>
          </Field>
          <Field label="Bundle">
            <input
              type="file"
              accept=".gz,.ndjson"
              disabled={importing}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void doImport(file);
              }}
            />
          </Field>
        </div>
        <div style={{ marginTop: 12 }}>
          <Checkbox
            label="Also import settings from the bundle"
            help="Credentials are usually redacted in a bundle, so you will need to re-enter them."
            checked={importSettings}
            onChange={setImportSettings}
          />
        </div>
        {importing && (
          <p className="muted" style={{ marginBottom: 0 }}>
            <span className="spinner" /> Importing…
          </p>
        )}
      </Card>

      <Card flush title="Recent exports">
        {(exports.data?.exports.length ?? 0) === 0 ? (
          <EmptyState title="No exports yet" />
        ) : (
          <Table headers={['Created', 'File', 'Destination', '#Records', '#Size', 'Verified']}>
            {exports.data!.exports.map((record) => (
              <tr key={record.id}>
                <td className="nowrap muted">{formatRelative(record.createdAt)}</td>
                <td className="mono">{record.fileName}</td>
                <td className="path faint">{record.destinationPath ?? '—'}</td>
                <td className="num">{record.recordCount.toLocaleString()}</td>
                <td className="num">{formatBytes(record.sizeBytes)}</td>
                <td>
                  {record.error ? (
                    <Badge tone="critical">{record.error.slice(0, 50)}</Badge>
                  ) : record.verified ? (
                    <Badge tone="ok">verified</Badge>
                  ) : (
                    <Badge>written</Badge>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------- agents */

function AgentsTab(): JSX.Element {
  const agents = useQuery<{ agents: AgentSummary[] }>('/api/agents', { pollMs: 20_000 });
  const tokens = useQuery<{ tokens: AgentToken[] }>('/api/agents/tokens');
  const mutation = useMutation();
  const toast = useToast();
  const [name, setName] = useState('NAS host');
  const [created, setCreated] = useState<string | null>(null);

  const createToken = async () => {
    const result = await mutation.run<{ token: AgentToken }>('/api/agents/tokens', { body: { name } });
    if (result) {
      setCreated(result.token.token ?? null);
      tokens.refresh();
    } else if (mutation.error) {
      toast.push(mutation.error, 'error');
    }
  };

  const revoke = async (token: AgentToken) => {
    await mutation.run(`/api/agents/tokens/${token.id}`, { method: 'DELETE' });
    tokens.refresh();
  };

  return (
    <div className="stack">
      <Banner tone="info" title="Why an agent is needed at all">
        SMART data, volume labels, DrivePool duplication settings and PrimoCache statistics live on
        the Windows host and cannot be read from inside a Linux container. The agent is a PowerShell
        script that collects them and posts a JSON report here on a schedule. Everything else — the
        catalog, hashing, the storage map — works without it.
      </Banner>

      <Card flush title="Reporting agents">
        {(agents.data?.agents.length ?? 0) === 0 ? (
          <EmptyState title="No agent has reported yet">
            Create a token below, then run <code>Install-SakuraDriveAgent.ps1</code> on the host.
          </EmptyState>
        ) : (
          <Table headers={['Host', 'Version', 'Protocol', '#Reports', 'Last report', 'Status']}>
            {agents.data!.agents.map((agent) => (
              <tr key={agent.id}>
                <td>
                  <strong>{agent.hostname}</strong>
                </td>
                <td className="mono">{agent.agentVersion}</td>
                <td className="num">{agent.protocolVersion}</td>
                <td className="num">{agent.reportCount.toLocaleString()}</td>
                <td className="nowrap muted">{formatRelative(agent.lastReportAt)}</td>
                <td>
                  {agent.online ? (
                    <Badge tone="ok" dot>
                      reporting
                    </Badge>
                  ) : (
                    <Badge tone="warning" dot>
                      stale
                    </Badge>
                  )}
                  {agent.lastErrors.length > 0 && (
                    <div className="faint" style={{ fontSize: 11 }}>
                      {agent.lastErrors.map((error) => `${error.collector}: ${error.message}`).join('; ')}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Agent tokens">
        <div className="toolbar">
          <input
            className="grow"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Token name"
          />
          <button className="primary" onClick={() => void createToken()} disabled={mutation.busy}>
            Create token
          </button>
        </div>

        {created && (
          <Banner tone="warning" title="Copy this token now — it is shown only once">
            <code className="mono" style={{ wordBreak: 'break-all' }}>
              {created}
            </code>
          </Banner>
        )}

        <div style={{ marginTop: 14 }}>
          {(tokens.data?.tokens.length ?? 0) === 0 ? (
            <EmptyState title="No tokens yet" />
          ) : (
            <Table headers={['Name', 'Prefix', 'Created', 'Last used', 'Status', '']}>
              {tokens.data!.tokens.map((token) => (
                <tr key={token.id}>
                  <td>{token.name}</td>
                  <td className="mono">{token.prefix}…</td>
                  <td className="nowrap muted">{formatRelative(token.createdAt)}</td>
                  <td className="nowrap muted">{formatRelative(token.lastUsedAt)}</td>
                  <td>
                    {token.revokedAt ? <Badge tone="critical">revoked</Badge> : <Badge tone="ok">active</Badge>}
                  </td>
                  <td>
                    {!token.revokedAt && (
                      <button className="small danger" onClick={() => void revoke(token)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      </Card>
    </div>
  );
}
