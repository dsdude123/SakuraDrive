# Morning notes

Everything in the design is built and working. This file covers three things: what I
decided on your behalf where the brief was open, what needs your input before it is
useful on your actual hardware, and the two things I could not finish honestly.

Read **§1** and **§2** — they are short and they matter. §3 onwards is reference.

---

## 1. The one thing I had to guess at

> "Use workflows to implement different features."

I read this as *an internal workflow abstraction*, not GitHub Actions or anything
external. Every feature is a first-class workflow with one lifecycle: start on demand,
stop on demand, report progress, pause at the edge of the scheduled window and resume
from a saved cursor.

That reading is what makes the rest of your requirements fall out cleanly — the schedule,
the on-demand override, the progress bars and the stop button are all one mechanism
rather than six. If you meant something else, tell me; the engine is `packages/server/src/workflows/engine.ts`
and the six workflows around it are each about 150 lines, so redirecting is cheap.

---

## 2. What I need from you before this is useful on your hardware

I have no visibility into your actual machine, so these are placeholders that will be
wrong:

### 2a. Drive letters and mounts — **required**

`docker/docker-compose.yml` currently assumes:

| Assumed | What I guessed it is |
| --- | --- |
| `/mnt/p` | HDD pool (DrivePool virtual drive `P:`) |
| `/mnt/s` | SSD pool |
| `/mnt/e`, `/mnt/f` | two pool member disks |
| `/mnt/g` | the standalone PrimoCache SSD |
| `/mnt/d/SakuraDriveExports` | where export bundles are written |

Replace with your real letters, one line per pool member disk. Settings → Catalog roots
has a **Check mount** button that tells you immediately whether the container can see a
path, so this is quick to get right.

### 2b. Should pool member disks be catalogued individually? — **strongly recommend yes**

Cataloguing just the pool (`P:`) gives you everything except one thing: it cannot say
*which disk* a file lived on. Add each member disk as a `poolpart` root with the same
pool id and the disaster-recovery report becomes exact — "these 4,182 files had no second
copy and are gone" rather than "roughly this much was unduplicated".

The cost is roughly double the catalog rows and double the scan time.

**Set `hashEnabled: false` on the pool-part roots.** Otherwise every file is hashed once
through the pool and again through each part — the same bytes, several times over. Hash
the pool root only. The per-root toggle is in Settings → Catalog roots.

### 2c. What is expected to be in Backblaze — **required for backup health**

You said not everything gets the Backblaze treatment. Nothing is expected until you say
so, so backup verification reports nothing until you add expectation rules under
Settings → Backup. Each rule is: a catalog root, include/exclude globs, and the matching
Kopia source string.

Run `kopia snapshot list` on the host and send me the source strings if you want me to
pre-fill them.

### 2d. Kopia credentials, Discord webhook, timezone

All entered in the UI. The timezone matters more than it looks: it is what the schedule
grid is interpreted in.

---

## 3. Where I could not fully deliver

Two items, both because the information genuinely is not available to me.

### 3a. PrimoCache monitoring (stretch goal) — **not achievable as specified**

RomexSoftware publishes no command-line interface, no performance counters and no
documented API for PrimoCache. Its statistics exist only inside its own GUI. I could not
find a supported way to read them programmatically, and I was not willing to ship
something that scrapes an undocumented internal surface and silently reports nonsense
when it changes.

What I built instead: the agent looks for a CLI beside the installed product, and when it
finds none it reports *why* — which shows up on the Drives page as an explicit "no
statistics available" with the reason, rather than an empty panel you cannot interpret.
The server side, the storage schema and the UI panel are all done, so if a supported
interface appears the only change is one function in the agent
(`Get-PrimoCacheInventory`, ~20 lines).

**Question:** is there a PrimoCache interface you know of that I have missed? If you have
seen its numbers anywhere outside the GUI, tell me where and I will wire it up.

### 3b. `dpcmd` output format — **needs one check against your install**

I could not verify the exact text `dpcmd list-poolparts` and `dpcmd get-duplication`
print on your DrivePool version — the format has changed across releases and I have no
DrivePool to run.

The parser is deliberately tolerant (it recognises a pool part by its `PoolPart.*` folder
and picks up labels and sizes from surrounding lines however they are formatted), and
there are two fallbacks so nothing is blocked either way:

- pool parts are also discovered from the `PoolPart.*` folders on each disk, with no
  `dpcmd` at all;
- duplication levels can be typed into Settings → Duplication, and manual rules always
  win over agent-reported ones.

**Please run these two and paste the output:**

```powershell
& 'C:\Program Files\StableBit\DrivePool\dpcmd.exe' list-poolparts P:\
& 'C:\Program Files\StableBit\DrivePool\dpcmd.exe' get-duplication 'P:\Media'
```

Ten minutes with that output and the parser matches your version exactly. Until then, the
UI route works.

---

## 4. Decisions I made — worth a glance, easy to change

| Decision | Why | If you disagree |
| --- | --- | --- |
| **TypeScript / Node 22, SQLite, React** | One process, one file to back up, no external services. A few million files is well within SQLite | Structural; ask before I start |
| **Agent is PowerShell, not a compiled binary** | Nothing to install on the host, and you can read what it does | Straightforward to port |
| **Bit rot is found by *periodic re-hashing*, default every 90 days** | Rot leaves size and mtime untouched, so nothing else would ever schedule the file to be read again | See §5 — the number matters |
| **Pool mounts are read-only** | This tool never needs to write to your data | — |
| **Credentials redacted from export bundles by default** | Bundles are written outside the app and end up in cloud storage | Toggle in Settings |
| **A mass deletion raises a critical alert at 10%** | A dead disk and an unmounted share look identical from inside a container | Threshold is configurable |
| **An unreadable root skips the scan entirely** | Otherwise a missing bind mount would mark the whole catalog deleted | — |
| **Removing a root keeps its catalog** | A root deleted by accident must not take the record of what was on that disk with it. It is listed as orphaned with an explicit purge button | — |
| **Single admin account** | It is your NAS | Multi-user is a schema change |
| **Kopia bundled in the image (~40 MB)** | Backup verification needs it | `--build-arg INSTALL_KOPIA=false` |
| **Default schedule: 01:00–07:00 weeknights, 01:00–10:00 weekends** | A guess at when nobody is streaming | Repaint on the Schedule page |
| **Discord batches alerts over 30s** | A controller dropping eight drives should be one message, not eight | Configurable, 0 disables |
| **Agent reports every 15 minutes** | Often enough to catch a drive going bad | `-IntervalMinutes` |

---

## 5. The re-hash interval deserves a decision

This is the one default whose "right" value depends on numbers only you have.

Bit rot is only detected when a file is read again. That is scheduled solely by
`rehashIntervalDays` (default 90). So the question is: **can your pool be fully re-hashed
within that window, given your schedule and throttle?**

Rough arithmetic:

```
hours per week painted × 3600 × throughput  =  bytes per week
```

With the default overnight schedule (~44 h/week) at an unthrottled ~150 MB/s that is
about 23 TB/week, so a 90-day cycle covers roughly 290 TB. Throttle to 50 MB/s and it is
about 97 TB.

**Tell me the pool's total size** and I will set the interval and throttle so a full pass
completes comfortably inside it. If a full pass cannot finish, the scanner still works —
it always takes never-hashed and changed files first — but the oldest files are checked
less often than the interval implies, and it is better to know that than to assume
otherwise.

The Workflows page shows the queue depth and progress, so this is measurable after the
first run rather than guesswork.

---

## 6. Smaller things you may want to change

- **Alert thresholds** (Settings → Thresholds) are set to be actionable rather than
  quiet: one pending sector is a warning, and any counter that is *rising* escalates even
  below the critical threshold. If that is too noisy for a pool of aging drives, raise
  `warnAbove` per attribute.
- **Latency alerting** needs 3 consecutive bad samples above 100 ms (warning) / 500 ms
  (critical). Given "clients lock up", 500 ms may be too forgiving — worth watching the
  charts on a drive detail page for a week and then tuning.
- **Retention**: SMART history 365 days, performance samples 30 days, resolved alerts 365
  days, 50 scan runs of change history. The change history is the DR artefact, so raise
  it if you want a longer window.
- **Auth**: on by default. `SAKURADRIVE_DISABLE_AUTH=true` skips it for a trusted LAN —
  but note the Kopia credentials are readable through the API, so I would leave it on.

---

## 7. What is verified, and what is not

**Verified by running it**, not just by unit tests: I built the Docker image, started the
container, created an account, configured a root, ran a catalog scan (confirming
duplication-aware sizes: 24 bytes logical → 48 effective at 2×), ran the hash scan,
fetched the treemap and dashboard, produced an export bundle, then simulated bit rot by
rewriting a file to the same byte count with its mtime restored — the scanner detected
it, confirmed it on re-read, raised the critical alert, and cleared the alert when the
finding was resolved.

- 535 automated tests (shared 163, server 335, web 37), all green
- 53 Pester tests for the agent's parsers, all green
- The agent runs end-to-end and degrades gracefully: on a machine with no Windows cmdlets
  at all it still produces a valid report naming every collector that could not run
- A cross-language contract test: the agent's own parsers generate the fixture the server
  test ingests, so a protocol change on either side fails the build

**Not verified, because I have no access to it:**

- Anything against real Windows: `Get-PhysicalDisk`, `Get-Volume`, `fsutil`, perf
  counters, real `smartctl` output from your controllers
- Real DrivePool: see §3b
- A real Kopia repository against Backblaze (the client is tested against fixtures and a
  fake CLI runner, and `Settings → Backup → Test connection` will tell you in seconds)
- WSL2 `drvfs` scan throughput. Reading `P:` through `/mnt/p` goes through a translation
  layer and is slower than native. The first catalog scan will show you the real number;
  if it is bad, mounting the pool as an SMB share into the container is the usual
  alternative and I can add support for that

---

## 8. What I would do next, in order

1. Fix the `dpcmd` parser against your actual output (§3b) — 10 minutes with a paste.
2. Set the re-hash interval and throttle from your pool size (§5).
3. Write the backup expectation rules from your real Backblaze policy (§2c).
4. Watch the first full catalog scan and tune the schedule from the measured throughput.
5. Only then: the remaining stretch-goal polish — per-drive throughput charts over longer
   windows, and a scheduled self-test trigger (`smartctl -t short`) from the agent.

---

## 9. Repository layout

```
packages/shared   domain logic used by both sides — schedule maths, duplication
                  resolution, treemap layout, glob matching, SMART rules, the agent
                  protocol, the settings schema
packages/server   Fastify API, SQLite, the workflow engine, the collectors
packages/web      React interface
agent             PowerShell agent, scheduled-task installer, Pester tests
docker            Dockerfile and compose file
docs              architecture, agent setup, disaster recovery runbook, API reference
```

Start with `README.md`, then `docs/ARCHITECTURE.md` if you want to know why anything is
shaped the way it is. `docs/DISASTER-RECOVERY.md` is the one to read before you need it.
