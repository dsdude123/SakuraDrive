# 🌸 SakuraDrive

NAS monitoring, cataloguing and disaster-recovery tooling for a Windows Server host
running StableBit DrivePool, deployed as a single Docker container on WSL2.

It answers the questions that matter when a disk starts to go:

- **Is a drive failing?** SMART for every disk, named by the label on its caddy
  (`DRIVEPOOL27`), not by `\\.\PHYSICALDRIVE7`.
- **What exactly did I lose?** A full file catalog with created / modified / deleted
  differences between scans, and a per-disk report of which files had no second copy.
- **Is anything rotting?** Periodic re-hashing that flags files whose content changed
  while their size and timestamp did not.
- **Where did the space go?** A WizTree-style treemap that accounts for DrivePool
  duplication — a 1 GB file at 2× really does cost 2 GB.
- **Is it actually backed up?** Verification that everything you expect to be in your
  Kopia repository is in it.
- **Why is everything slow?** Sustained disk latency and queue depth, which is the
  pattern behind clients locking up.

Alerts go to Discord. Everything is exported off-box automatically, because the catalog
is most valuable exactly when the machine holding it has just lost a disk.

---

## Quick start

```bash
git clone https://github.com/dsdude123/sakuradrive.git
cd sakuradrive/docker
cp .env.example .env          # optional: port, timezone, log level

# Edit docker-compose.yml so the bind mounts match your drive letters.
docker compose up -d --build
```

Open `http://<host>:8080`, create the account it asks for, then:

1. **Settings → Catalog roots** — add your pools. `/mnt/p` inside WSL2 is Windows `P:`.
   Press *Check mount* on each one; it tells you straight away whether the container can
   actually see the path.
2. **Settings → Agents** — create a token, then run the installer on the Windows host
   (see [docs/AGENT.md](docs/AGENT.md)). Without it there is no SMART data.
3. **Schedule** — paint the hours when heavy I/O is acceptable. The default is
   01:00–07:00 on weeknights and 01:00–10:00 at weekends.
4. **Settings → Backup & export** — point at a folder your host already backs up.

Everything else is optional and configured from the same interface. The container needs
no configuration beyond a port, a data volume and the bind mounts.

---

## How it fits together

```
   Windows Server host                        WSL2 / Docker
 ┌──────────────────────────┐              ┌─────────────────────────────┐
 │  SakuraDrive agent       │  HTTPS POST  │  SakuraDrive container      │
 │  (PowerShell, SYSTEM)    │─────────────▶│                             │
 │   • smartctl             │  every 15m   │   Fastify API + React UI    │
 │   • Get-PhysicalDisk     │              │   SQLite (WAL)              │
 │   • Get-Volume / fsutil  │              │   workflow engine           │
 │   • dpcmd (DrivePool)    │              │   Kopia CLI (read-only)     │
 │   • PhysicalDisk counters│              │                             │
 └──────────────────────────┘              │   reads the pools through   │
                                           │   read-only bind mounts     │
   P:\  S:\  E:\  F:\ ...  ────────────────▶  /mnt/pools/*  /mnt/parts/* │
                                           └─────────────────────────────┘
                                                        │
                                                        ▼
                                        export bundles → a folder your
                                        host already backs up to Backblaze
```

The agent exists for one reason: SMART data, volume labels, DrivePool settings and
PrimoCache statistics live on Windows and cannot be read from inside a Linux container.
Everything else — the catalog, hashing, the storage map, backup verification — works
without it.

---

## Features implemented as workflows

Every feature is a workflow with the same lifecycle: it can be started on demand,
stopped on demand, reports progress, and — if it is heavy — pauses at the edge of its
scheduled window and resumes from a saved cursor rather than starting over.

| Workflow | Respects the I/O window | What it does |
| --- | --- | --- |
| `catalog.scan` | yes | Walks every root, records created / modified / deleted files, rebuilds directory rollups |
| `catalog.hash` | yes | Hashes files and compares against the stored hash — the bit-rot scanner |
| `catalog.duplication` | no | Recomputes duplication levels and finds files with fewer copies than configured |
| `backup.verify` | no | Lists the latest Kopia snapshot and reports what should be backed up but is not |
| `export.backup` | no | Writes and verifies an export bundle to each destination |
| `maintenance.prune` | no | Retention, session expiry, agent-freshness checks |

**Scheduling.** Cataloguing and hashing read the whole pool, which is exactly the
workload that makes clients stutter. They only start automatically inside the hours you
paint on a 7×24 grid. When an hour ends, a running workflow is *asked* to stop — it
saves its position and resumes in the next window. "Run now" ignores the schedule
entirely and keeps running until it finishes or you stop it.

**Throttling.** Independently of the schedule you can cap hashing throughput in MB/s,
add a delay between files, and set how many files are hashed in parallel. One worker
with a 50 MB/s cap is close to invisible on a spinning pool.

---

## Safety properties worth knowing

These matter because this is a disaster-recovery tool, and the failure modes it is
supposed to help with are exactly the ones that could corrupt its own data.

- **Catalog rows are never hard-deleted.** A file that disappears is marked deleted and
  kept, so the history survives the event you need it for.
- **A missing bind mount never wipes the catalog.** If a root is unreadable, the scan
  skips it and raises a critical alert instead of concluding that every file is gone.
- **Mass deletions are flagged.** When one scan marks more than 10% of a root as
  deleted, that gets a critical alert of its own — a dead disk and an unmounted share
  look identical from inside a container, and you should be told which it was.
- **A paused scan never applies deletions.** Only a scan that walked a root in full is
  allowed to conclude that anything is missing.
- **An empty backup listing is treated as an error**, not as "everything is missing".
- **Bit-rot findings are re-read before being confirmed**, so a transient controller
  fault does not produce a false alarm.
- **Removing a root does not delete its catalog.** The rows are kept and listed as
  orphaned, so a root deleted by accident does not take the record of what was on that
  disk with it. Purging is an explicit, separate action.
- **An alert is only cleared by a report that actually covered its drive.** A poll where
  smartctl failed to read one disk leaves that disk's alerts alone, rather than reporting
  a failing drive as healthy because it could not be seen.
- **Credentials are redacted from export bundles by default**, because those bundles are
  written outside the app and often end up in cloud storage.
- **The pool mounts are read-only.** SakuraDrive never writes to your data.

---

## Development

```bash
npm install
npm test          # 535 tests: shared (163), server (335), web (37)
npm run typecheck
npm run build

npm run dev       # API on :8080, UI on :5173 with a proxy
```

Agent tests need PowerShell 7 and Pester 5+:

```bash
pwsh -Command "Invoke-Pester -Path agent/tests -Output Detailed"     # 53 tests
```

| Package | What it holds |
| --- | --- |
| `packages/shared` | Domain logic used by both sides: schedule arithmetic, duplication resolution, treemap layout, glob matching, SMART rules, the agent protocol, the settings schema |
| `packages/server` | Fastify API, SQLite persistence, workflow engine, collectors |
| `packages/web` | React interface |
| `agent` | PowerShell agent, installer and Pester tests |
| `docker` | Dockerfile and compose file |

Further reading: [architecture](docs/ARCHITECTURE.md) ·
[agent setup](docs/AGENT.md) · [disaster recovery](docs/DISASTER-RECOVERY.md) ·
[API reference](docs/API.md)

---

## License

MIT.
