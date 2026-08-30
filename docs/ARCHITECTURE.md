# Architecture

## Why it is shaped this way

Two constraints drove almost every decision.

**The container cannot see the hardware.** SakuraDrive runs on Linux inside WSL2. SMART
data, volume labels, the NTFS dirty bit, DrivePool's own configuration and PrimoCache
statistics are all Windows-side. So there is an agent, and it is a PowerShell script
rather than a compiled binary — nothing to install on the host beyond the script itself,
and it is readable by the person running it.

**Heavy I/O is user-visible.** Reading every byte of a media pool makes clients stutter.
So the expensive work is not a background thread that runs whenever it likes: it is a
workflow that only starts inside hours the operator painted, pauses cleanly when they
end, and resumes from a cursor.

Everything else follows from those two, plus one more: this is a tool you reach for after
a disk has died, so it must never be the thing that lost the data.

## Processes

```
┌──────────────────────────────── container ────────────────────────────────┐
│                                                                            │
│  Fastify  ──── /api/*            static /app/public (built React app)      │
│     │                                                                      │
│     ├── services ───────────────────────────────────────────────────────┐  │
│     │   SettingsService   one JSON document, validated by a zod schema   │  │
│     │   AlertService      conditions, deduplicated by key                │  │
│     │   AgentService      ingests reports, evaluates SMART rules         │  │
│     │   CatalogService    files, changes, directory rollups, DR queries  │  │
│     │   BitrotService     findings and their lifecycle                   │  │
│     │   BackupService     Kopia listing vs. expectation rules            │  │
│     │   ExportService     gzipped NDJSON bundles in and out              │  │
│     │   DiscordNotifier   outbox with batching and backoff               │  │
│     └─────────────────────────────────────────────────────────────────────┘
│     │                                                                      │
│  WorkflowManager ── ticks every 30s ── starts / pauses / resumes runs      │
│     │                                                                      │
│  SQLite (WAL)  /data/sakuradrive.sqlite                                    │
└────────────────────────────────────────────────────────────────────────────┘
```

One process, one database, no queue, no cache. A NAS with a few million files does not
need more, and every extra moving part is another thing to recover after a failure.

## The workflow engine

A workflow declares whether it respects the I/O schedule, which concurrency group it
belongs to, and whether the scheduler may start it on its own:

```ts
interface WorkflowDefinition {
  id: WorkflowId;
  respectsSchedule: boolean;
  concurrencyGroup: string | null;   // 'io' — only one at a time
  autoStart: boolean;
  hasWork(): boolean | Promise<boolean>;
  run(ctx: WorkflowContext): Promise<WorkflowResult>;
}
```

The context it receives is what makes pausing work:

```ts
ctx.shouldContinue()   // false when stopped, or when the window has closed
ctx.setCursor(state)   // persisted; handed back on the next run
ctx.getCursor()
ctx.setProgress({ done, total, unit, message, bytes })
```

A workflow returns `{ state: 'paused' }` to say "there is more to do". The same run row
is reused when it resumes, so a scan interrupted three nights running is still one run,
with one cursor and one set of statistics.

The catalog scan's cursor is a LIFO work list of directories still to visit. Resuming
continues at the exact directory the previous window ended on rather than re-walking the
tree. The hash workflow's cursor is simpler — its queue is a database query — but it
records the total it established at the start of the run so the progress bar stays honest
across resumes.

Only one workflow in the `io` group runs at a time, and cataloguing is ordered before
hashing: hashing a stale file list wastes the window.

## Data model

The interesting parts:

**`files`** keeps `rel_path` with the on-disk casing for display and `path_key`
lower-cased for every lookup, join and uniqueness constraint. NTFS is case-insensitive;
treating `Media/A.mkv` and `media/a.mkv` as two files would produce phantom
created/deleted pairs on every scan.

Alongside the hash it stores `hash_size_bytes` and `hash_mtime_ms` — the size and
timestamp *at the moment the hash was taken*. Bit rot is precisely "content changed while
those did not", so both are needed to distinguish rot from a legitimate edit.

**`catalog_changes`** records every created / modified / deleted / restored event per
scan run. This is the disaster-recovery artefact: after a disk dies, one scan produces
the definitive list of what is now missing from the pool.

**`dir_stats`** holds directory rollups, rebuilt at the end of each scan by one grouped
query plus an in-memory roll-up from the deepest directory upward. Recursive SQL over
millions of rows on every page load would make the storage map unusable; this makes it
instant.

**`alerts`** are conditions, not events. Raising the same `dedupe_key` twice updates the
row. A drive with a pending sector produces one alert that stays open until the condition
clears — not one per poll. Collectors call `reconcile(category, activeKeys, keyPrefix)` to
say "these are all the problems I can see right now", which resolves anything they
previously reported and no longer do.

The `keyPrefix` matters more than it looks. Reconciliation is scoped per entity — per
drive, per volume, per pool — so a poll in which smartctl failed to read one disk clears
nothing for that disk. Clearing the whole category would mean an unreadable drive's real
alerts silently resolving, which is the worst failure a monitor has: reporting a dying
disk as healthy because it could not see it.

## The pool is a view over its members

Cataloguing both the pooled drive and its member disks would read every file twice and
hash it twice, for a tree the members already describe completely. So only the members
are scanned, and the pool is derived: the union of its pool-part roots, deduplicated by
pool-relative path, addressed by the synthetic root id `pool:<poolId>`.

That synthetic id flows through browse, search, the storage map and the totals exactly
like a real root. Its directory rollups are built by the same code that builds a real
root's, from deduplicated rows, and rebuilt whenever a member disk finishes scanning.

The derived view is also strictly more informative than scanning the pooled drive would
be, because the number of members holding a path *is* its observed duplication. The
storage map therefore reports what the pool actually spends — `size × copies present` —
rather than `size × the level the rule asks for`, and the gap between the two is itself
the under-duplication report.

It also changes what "missing" means, correctly: a file deleted from one member but
still present on another has not been lost, and only a path with no surviving copy
anywhere counts as missing from the pool.

## Who reads the disks

**The agent. All of it.** There is no second path and no setting.

The container cannot read most of these volumes and never will. WSL2 only surfaces
lettered drives under `/mnt/<letter>`, and a pool with more disks than spare letters has
members with none. Folder mount points look like the answer and are not: drvfs refuses
to cross a reparse point into another volume and returns `EIO`.

Handing out drive letters would work until it did not — 26 minus what is in use, and the
container's plumbing dictating how the host may be laid out. Supporting *both* would have
been worse still: two code paths, two sets of failure modes, and a setting nobody should
have to reason about. So the reading happens on the side of the boundary that can see
everything, for every root, always. The agent opens a volume by GUID path,
`\\?\Volume{guid}\PoolPart.guid`, and needs no letter, no mount point and no bind
mount. Add a disk, re-letter the array, move to a bigger machine: nothing in the
container's configuration changes, because it has no opinion about the host's disks.

It is also faster. A native read beats the same bytes pulled through drvfs, which at
95 TB is measured in days of hashing.

What does *not* move is the interesting part:

| Server | Agent |
| --- | --- |
| The I/O window and when to pause | Enumerating a directory |
| The catalog run and its cursor | Reading a file's size and mtime |
| What "created", "modified" and "deleted" mean | Computing a hash |
| Whether a hash mismatch is bit rot | Re-reading once when a hash disagrees |
| The deletion sweep, and refusing it after a partial scan | |
| Duplication resolution, dir rollups, the pool view | |

The agent reads bytes; it holds no opinions. Batches land through the same `recordFiles`
path the catalog has always used, so "what a scan means" has one implementation.

### How the window crosses the process boundary

The agent posts a batch and, in effect, asks "more?". The reply says yes or no. When the
window closes the server says no, and the agent stops at that batch boundary and returns
its cursor. It knows nothing about schedules, and a paused scan resumes at the directory
it stopped on rather than re-walking the tree.

### When the agent is not there

Three failure modes, each with a defined outcome:

- **Job never claimed** — the agent is not running. After `agentClaimTimeoutSeconds` the
  job is cancelled and the scan fails loudly. Waiting forever would leave the workflow
  looking busy while nothing at all happened, which is the worst kind of failure because
  it does not look like one.
- **Agent goes quiet mid-scan** — a reboot, say. The job is requeued after five minutes
  with its cursor intact, and picked up when the agent returns.
- **Job fails** — a critical alert, and the catalog is left exactly as it was.

In all three, **a half-walked tree is never read as deletions**. That is the guarantee
the disaster-recovery report rests on, and it is why an unfinished scan abandons its
catalog run rather than completing it.

Reachability is judged from what the agent last reported rather than from a `stat` the
container cannot perform — which is a better question anyway, because it distinguishes
"DrivePool says this part is missing" from "nobody has told me anything".

## Disaster recovery, precisely

Catalogue each disk's `PoolPart.*` folder as its own root with the same pool id and the
question "what does this disk take with it?" becomes exact:

```sql
SELECT COUNT(*), SUM(size_bytes) FROM (
  SELECT f.path_key, MAX(f.size_bytes) AS size_bytes FROM files f
   WHERE f.root_id IN (:partsOnThisDisk) AND f.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM files o
                      WHERE o.root_id IN (:partsOnOtherDisks)
                        AND o.path_key = f.path_key
                        AND o.deleted_at IS NULL)
   GROUP BY f.path_key)
```

A file is unrecoverable exactly when no part **on another physical disk** holds the same
pool-relative path. Without pool-part roots the report falls back to configured
duplication levels and says so in the response — useful, but it can only tell you what
*should* have a second copy, not what does.

### The failure domain is a disk, not a pool part

DrivePool's duplication setting promises that the N copies of a file land on N different
*drives*; that is what makes it redundancy at all. So every pool-part root is resolved to
the physical disk behind it — `pool_parts.device_key` from the agent's pool inventory,
falling back to the volume's device list — and copies are counted with
`COUNT(DISTINCT <device>)` rather than `COUNT(*)`.

The difference bites when two partitions of one drive are both members of a pool.
DrivePool writes two copies, both on that drive; counting parts would call the file
duplicated, and losing the drive would lose it anyway. Counting disks reports one copy,
marks it under-duplicated, and treats every part of that disk as a single failure domain
in the DR report. The layout itself raises a critical alert
(`duplication:<pool>:shared-disk:<device>`), since re-balancing cannot fix it.

A part whose disk cannot be determined becomes its own failure domain: assuming two
unknowns were the same drive would understate redundancy and cry wolf about healthy data,
while the opposite mistake is what the shared-disk alert exists to catch.

The same comparison run the other way finds under-duplicated files: paths present on
fewer distinct disks than the level their DrivePool rule requires.

## Duplication

DrivePool sets duplication per folder and descendants inherit it, so resolution is a
longest-prefix match. Rules come from the agent (`dpcmd get-duplication`, probed
breadth-first to a bounded depth, keeping only folders that differ from what they
inherit) or from rules typed into the interface. Manual rules win at equal depth, so a
human can always correct a bad reading.

Every catalogued file stores its resolved level, so `size_bytes * duplication_level` is
what the pool actually spends — which is what the storage map shows by default.

## Backup verification

Kopia is shelled out to, read-only. `kopia ls -lr --json <snapshot>` on a large
repository emits millions of entries in one JSON array, so it is consumed by an
incremental parser that emits objects as each one closes, and inserted into a temporary
table. The comparison then streams the catalog and does an indexed point lookup per
expected file.

"Expected" is defined by explicit include/exclude rules per root, because not everything
on the pool warrants cloud storage. Nothing is expected until a rule says so.

A `manifest` mode reads a plain listing file instead, for when the container cannot reach
the repository — `kopia ls -lr <snapshot> > /data/backup-list.txt` on any machine that
can.

## Export format

Gzipped NDJSON. The first line is a manifest, the second the settings document, then one
`{"t":"<table>","r":{...}}` per row. Streamed in both directions, so a catalog of tens of
millions of rows never has to fit in memory. Import is `INSERT OR REPLACE`, which makes
it idempotent, with an optional `replace` mode that clears each table first.

Bundles are written to a directory outside the app's own volume, verified by reading them
back and comparing the record count, and pruned to a retention count.

## Testing

552 automated tests across the three packages, plus 78 Pester tests for the agent.

The one that ties the halves together is the contract test: `agent/tools/New-ContractFixture.ps1`
runs the agent's own parsing functions over representative smartctl and dpcmd output and
writes the result to `packages/server/src/test/fixtures/agent-report.json`. The server
test parses that fixture against the protocol schema and pushes it through the real
ingest path. A change on either side that breaks the contract fails the build rather than
producing an agent that silently reports nothing.
