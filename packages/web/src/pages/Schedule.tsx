import { useEffect, useState } from 'react';
import {
  defaultSchedule,
  emptySchedule,
  enabledHoursPerWeek,
  formatSchedule,
  fullSchedule,
  normalizeSchedule,
  type Settings,
} from '@sakuradrive/shared';
import { api } from '../api/client.js';
import { PageHeader } from '../components/Layout.js';
import { ScheduleGrid } from '../components/ScheduleGrid.js';
import { Banner, Card, Checkbox, Field, Loading } from '../components/ui.js';
import { useQuery } from '../hooks/useApi.js';
import { useToast } from '../hooks/useToast.js';

interface SettingsResponse {
  settings: Settings;
  schedule: { summary: string; hoursPerWeek: number; empty: boolean };
}

export function SchedulePage(): JSX.Element {
  const { data, loading, refresh } = useQuery<SettingsResponse>('/api/settings');
  const toast = useToast();

  const [grid, setGrid] = useState<string[]>(emptySchedule());
  const [throttle, setThrottle] = useState<Settings['schedule'] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    setGrid(normalizeSchedule(data.settings.schedule.heavyIo));
    setThrottle(data.settings.schedule);
    setDirty(false);
  }, [data]);

  if (loading && !data) return <Loading />;
  if (!data || !throttle) return <Loading />;

  const timezone = data.settings.general.timezone;

  const save = async () => {
    setSaving(true);
    try {
      await api('/api/settings/schedule', { method: 'PUT', body: { heavyIo: grid } });
      await api('/api/settings', {
        method: 'PATCH',
        body: {
          schedule: {
            pauseOutsideWindow: throttle.pauseOutsideWindow,
            autoResume: throttle.autoResume,
            maxHashMBps: throttle.maxHashMBps,
            interFileDelayMs: throttle.interFileDelayMs,
            hashConcurrency: throttle.hashConcurrency,
            scanConcurrency: throttle.scanConcurrency,
          },
        },
      });
      toast.push('Schedule saved', 'success');
      setDirty(false);
      refresh();
    } catch (error) {
      toast.push(error instanceof Error ? error.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const update = (next: string[]) => {
    setGrid(next);
    setDirty(true);
  };

  const patchThrottle = (patch: Partial<Settings['schedule']>) => {
    setThrottle({ ...throttle, ...patch });
    setDirty(true);
  };

  return (
    <>
      <PageHeader
        title="Schedule"
        subtitle={`When cataloguing and hashing may run · times are ${timezone}`}
        actions={
          <button className="primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving && <span className="spinner" />}
            Save schedule
          </button>
        }
      />
      <div className="content">
        <Banner tone="info" title="Why this exists">
          Cataloguing and hashing read the whole pool, which is exactly the workload that makes
          clients stutter. Painted hours are the only times those workflows start on their own — and
          when an hour ends, a running workflow is asked to stop, saves its position and resumes in
          the next window rather than starting over.
        </Banner>

        <Card
          title="Weekly I/O window"
          description={`${formatSchedule(grid)} · ${enabledHoursPerWeek(grid)} hours per week`}
          actions={
            <>
              <button className="small" onClick={() => update(defaultSchedule())}>
                Overnight preset
              </button>
              <button className="small" onClick={() => update(fullSchedule())}>
                Always
              </button>
              <button className="small ghost" onClick={() => update(emptySchedule())}>
                Clear
              </button>
            </>
          }
        >
          <div className="stack">
            <ScheduleGrid value={grid} onChange={update} timezone={timezone} />
            <div className="faint" style={{ fontSize: 12 }}>
              Click a cell to toggle it, or drag to paint a block. Click an hour number to toggle
              that hour on every day, or a day name to toggle the whole day. The blue outline marks
              the current hour in {timezone}.
            </div>
            {enabledHoursPerWeek(grid) === 0 && (
              <Banner tone="warning" title="No hours are painted">
                Nothing will be catalogued or hashed automatically. You can still start each
                workflow by hand from the Workflows page.
              </Banner>
            )}
          </div>
        </Card>

        <Card title="Behaviour and throttling" description="How gently the scans treat the disks">
          <div className="form-grid">
            <Field
              label="Hash throughput cap (MB/s)"
              help="0 means unthrottled. A cap leaves the disks idle between reads, which is what keeps clients responsive during a scan."
            >
              <input
                type="number"
                min={0}
                value={throttle.maxHashMBps}
                onChange={(event) => patchThrottle({ maxHashMBps: Number(event.target.value) })}
              />
            </Field>
            <Field
              label="Delay between files (ms)"
              help="Extra pause after each file. Even 20ms noticeably reduces the impact on spinning disks."
            >
              <input
                type="number"
                min={0}
                max={5000}
                value={throttle.interFileDelayMs}
                onChange={(event) => patchThrottle({ interFileDelayMs: Number(event.target.value) })}
              />
            </Field>
            <Field
              label="Parallel hash workers"
              help="1 is gentlest on spinning rust; higher values help on SSD pools."
            >
              <input
                type="number"
                min={1}
                max={16}
                value={throttle.hashConcurrency}
                onChange={(event) => patchThrottle({ hashConcurrency: Number(event.target.value) })}
              />
            </Field>
          </div>

          <div className="stack" style={{ marginTop: 16 }}>
            <Checkbox
              label="Pause running work when the window closes"
              help="Turning this off lets a scan that started inside a window run to completion."
              checked={throttle.pauseOutsideWindow}
              onChange={(value) => patchThrottle({ pauseOutsideWindow: value })}
            />
            <Checkbox
              label="Resume automatically when the next window opens"
              checked={throttle.autoResume}
              onChange={(value) => patchThrottle({ autoResume: value })}
            />
          </div>
        </Card>
      </div>
    </>
  );
}
