# Performance benchmarks

The `perf.benchmark` workflow measures every disk, every pool, the container's own
storage, and — through a small client — the SMB shares as other machines see them.
Results are on the **Performance** page; settings are under **Settings → Thresholds →
Benchmarks**.

## When it runs

Every `intervalDays` (default 7), inside the I/O window. A due benchmark pauses a
scheduled catalog scan or hash run, takes its turn, and the paused run resumes where it
left off. It does not pause a run started with **Run now**. Benchmarks never run alongside
hashing: the contention would make healthy disks look slow.

After a failed run it waits 6 hours before trying again.

## What is measured

| Target | Where | Write | Read | Latency |
| --- | --- | --- | --- | --- |
| Disk | Volume root, outside the `PoolPart` folder | Sequential, write-through | Sequential, unbuffered | Random 4 KiB unbuffered reads (median and p95) |
| Pool | Pool drive letter (`J:\`) | Same as disk | Same as disk | Same as disk |
| Container | The data directory and each enabled export destination | Sequential, fsync'd | Sequential, page cache dropped first | fsync'd 4 KiB writes |
| Network | The share named on the client | Sequential, fsync'd | Sequential, cache bypassed where the OS allows | Small file create/fsync/delete |

Each test writes one file named `.sakuradrive-perf-<tag>.tmp` and deletes it afterwards,
including on failure. A disk is skipped (and shown as skipped) when it has less than
twice the test size plus 1 GiB free. Disks under 8 GiB and pool drive letters are not
tested as disks.

Disk and pool tests read through PrimoCache when it fronts the volume, so pool figures
include the cache. That is intended: it is what clients get.

### Reads that may be cached

If Windows refuses an unbuffered read, the agent falls back to a normal read and marks the
result as possibly cached. Those reads are shown as `~520` and are left out of every
comparison; latency is not measured for them.

## Slow disks

A disk is flagged slow when its read or write is below `slowFraction` (default 50%) of:

- the median of comparable disks: same pool, same media type, at least 2 others; or
- its own median over the last 5 benchmarks (at least 2).

Latency is flagged when it is above the reference divided by `slowFraction`. Disks that
are not in a pool are compared with their own history only.

## Cache coverage

With **Alert on pool members PrimoCache does not cover** on, every pool member that no
PrimoCache cache targets raises an alert. If PrimoCache is not reporting, nothing is
raised: no data is not the same as covered.

## Excluding disks

Untick **Benchmark** on a disk on the Performance page. Excluded disks are not tested and
not checked for cache coverage. The list is stored as `perfTest.excludedVolumeIds`.

## Network client

`sakuradrive-netperf.py` needs Python 3.8+ and nothing else. It runs on Windows, macOS
and Linux. It needs an agent token (Settings → Agents).

```sh
curl -o sakuradrive-netperf.py http://<server>:8080/api/perf/netperf.py
python3 sakuradrive-netperf.py --server http://<server>:8080 --token <token> --share '\\nas\Media'
```

On macOS or Linux, point `--share` at the mounted path (`/Volumes/Media`, `/mnt/media`).

| Option | Default | |
| --- | --- | --- |
| `--size-mb` | 256 | Size of the sequential test file |
| `--samples` | 30 | Small-file operations to time |
| `--client` | hostname | Name shown on the Performance page |
| `--no-submit` | | Print results without sending them |
| `--json` | | Print results as JSON |

Exit codes: 0 success, 1 the test failed, 2 the server rejected or could not be reached.
Schedule it with Task Scheduler, cron or launchd to keep results current.

## Alerts

All are in the `performance` category and resolve on the next good result.

| Key | Raised when |
| --- | --- |
| `bench:slow:<target>` | A disk is slow against its peers or its history |
| `bench:error:<target>` | A target's benchmark failed |
| `bench:uncached:<volume>` | A pool member is not fronted by PrimoCache |
| `bench:agent-unavailable` | No agent claimed the benchmark job |
