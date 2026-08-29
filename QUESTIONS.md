# Morning notes

*Updated after your comments on the handover.* Everything you flagged is done or
answered below. **One thing is left for you**: giving the fourteen letterless HDD pool
disks folder mount points, which now has a script (§5a). Everything else is closed.

---

## 1. What your comments changed

| Your comment | Outcome |
| --- | --- |
| `dpcmd` output pasted | **Done.** My parser was wrong in every particular; rewritten against your real 2.3.13 output and tested on it verbatim. |
| PrimoCache: "Yes! `rxpcc`" | **Done.** No longer a dead end — cache levels, sizes, defer-write and hit rates are collected. |
| Pool view should be virtual | **Done.** The pool is now derived from its member disks, not scanned. |
| Alarm on an unreadable root | **Done** (it already alerted during a scan; now it also alerts twice a day regardless of the schedule). |
| Agent must survive reboots | **Already did**, and now proves it — see §4. |
| Drive letters: `/mnt/j`, `/mnt/m` | **Done**, and it surfaced a real blocker — see §2. |
| Pool size figures | **Answered** — see §3. The 90-day default holds. |
| Individual disks outside the pool | Supported; they just need adding as roots. See §5. |
| "Script to enumerate volumes and choose which to mount" | **Done.** `agent/tools/Set-PoolDiskMountPoints.ps1` — see §5a. |
| Kopia snapshot sources listed | **Done.** Mapped, and it surfaced two gaps in the app — see §5b. |
| `rxpcc perf -a` output pasted | **Done.** The parser was looking for the wrong thing entirely; rewritten against it — see §5c. |
| "Use multiple agents" — deadline passed | Closed, nothing to do. |
| "Duplication puts the copies across different *physical disks*" | **Fixed.** Copies were counted per pool part, which is only the same number while every part is on its own drive. Now counted per physical disk — see §6. |

---

## 2. The one new blocker: your HDD pool disks have no drive letters

Your `rxpcc ls` output shows the fourteen `DRIVEPOOL*` volumes with **no drive letter** —
only `C:`, `D:`, `E:`, `F:`, `G:`, `J:` and `M:` have one, and `D:`/`E:`/`F:` are the
SanDisk SSDs.

That matters because WSL2 only exposes lettered drives under `/mnt/<letter>`. So the HDD
pool's member disks cannot currently be bind-mounted, which means they cannot be
catalogued or hashed — and per-disk cataloguing is what makes the recovery report exact.

**The fix is a folder mount point per disk**, which is the standard way around the
26-letter limit and survives reboots:

```powershell
New-Item -ItemType Directory -Path C:\PoolDisks\DRIVEPOOL4 -Force
$volume = Get-Volume -FileSystemLabel DRIVEPOOL4
$partition = Get-Partition -Volume $volume
Add-PartitionAccessPath -DiskNumber $partition.DiskNumber `
    -PartitionNumber $partition.PartitionNumber -AccessPath 'C:\PoolDisks\DRIVEPOOL4'
```

Then `/mnt/c/PoolDisks/DRIVEPOOL4` is visible in WSL2 and goes in `docker-compose.yml`.

Two things already account for this:

- **The agent needs no letters.** It finds each `PoolPart.*` folder by trying the drive
  letter, then folder mount points, then the volume GUID path — so SMART, pool
  membership and duplication all work today, unchanged.
- **The volumes page shows the gap.** Each volume displays its letter, or its mount
  point, or "not mounted" — which is exactly the list of disks still needing the above.

**Your SSD pool needs none of this.** `M:` is a DrivePool pool over `D:`, `E:` and `F:`
— the used figures add up exactly (878.94 + 849.01 + 797.08 = 2525.02 GB) — and those
have letters, so `docker-compose.yml` already catalogues them as pool members.

---

## 3. Re-hash interval: the 90-day default is right

From your figures, `J:` holds ~94.4 TiB used, `M:` ~2.5 TiB.

Against the default overnight window (~44 hours a week):

| Throttle | One full verification pass |
| --- | --- |
| Unthrottled (~150 MB/s) | **~30 days** |
| 100 MB/s | ~45 days |
| 50 MB/s | ~90 days — exactly at the limit |

So: **keep `rehashIntervalDays` at 90**, and start unthrottled. There is room for a
comfortable 3× margin, which matters because the scanner takes never-hashed and changed
files first — margin is what stops the oldest files drifting past their interval.

If clients notice the scan, throttle to ~100 MB/s before widening the window; below
~75 MB/s you would be relying on the whole window every night to stay inside 90 days.

The Workflows page shows queue depth and throughput, so this becomes measurable after
the first pass rather than arithmetic.

---

## 4. The agent already survives reboots

You asked whether it runs on its own. It does, and I have made that verifiable rather
than assumed:

- Registered as a **scheduled task running as SYSTEM**, so it needs nobody logged in and
  survives sign-out.
- **Two triggers**: one at boot (2-minute delay) so monitoring resumes without waiting
  out the interval, and one repeating every 15 minutes for the steady state.
- `StartWhenAvailable` catches up a run the machine slept through; a failed run now
  **retries up to 3 times at 5-minute intervals** rather than leaving monitoring dark
  until the next tick; `IgnoreNew` stops a slow run stacking on itself.

The installer now prints what it registered — the account, the run level and the trigger
count — and runs it once so you can confirm before walking away.

---

## 5. What still needs you

### 5a. Mount the HDD pool disks into folders, then add them — §2

Until then the HDD pool cannot be catalogued. Everything else works.

There is now a script for it: `agent/tools/Set-PoolDiskMountPoints.ps1`. Run it with
`-ListOnly` first — no elevation, changes nothing — and it prints every fixed volume with
its label, letter, size and whether WSL can currently reach it:

```
  #  Label            Ltr  FS     Size     Status    Reachable from WSL as
  1  DRIVEPOOL4       -    NTFS   7.3 TB   unmounted NOT VISIBLE
  2  SSDPOOl1         M:   NTFS   2.5 TB   letter    /mnt/m
```

Then run it elevated with no arguments and pick from the list — numbers, ranges like
`4-9`, or `all`; the invisible ones are suggested for you. It refuses to touch the system
volume, insists on an empty target folder, verifies each mount actually took, and prints
the docker-compose lines for what it mounted. `-WhatIf` shows the whole plan without
writing anything and `-Remove` undoes it.

One thing to check rather than trust: a folder mount point is a reparse point, and
whether WSL2's drvfs follows it into another volume is a WSL question, not a Windows one.
The script prints the `ls` command to confirm. If it comes back empty, give the volumes
drive letters instead — you have enough spare for the pool as it stands, and letters
always work.

### 5b. What belongs in Backblaze — **answered**

You said Kopia holds `C:\Users`, `D:`, `E:`, `F:`, `J:\AmpDatastore`, `J:\Tier0`,
`J:\Tier1` and `M:\Tier1`. Two things fall out of that, and both needed code:

- **The SSD pool is fully covered.** D, E and F are snapshotted whole, so everything in
  the pool is in the repository. `M:\Tier1` is the pooled view of the same data, so it
  is redundant with them — harmless, but not extra protection.
- **`J:\Tier2`, `Tier3` and `Tier4` are not backed up at all.** If one of the fourteen
  HDD disks dies, whatever it held in those tiers that was not duplicated is gone.

That second point was invisible in the app: a root with no expectation was simply never
verified. It raises no alert — leaving a tier out is a cost decision, not a fault — but
the Backup health page now has a **"What the rules cover"** panel listing, per root, what
the rules reach into and what they do not, largest gap first. The list you want the
morning a disk dies is the one you should be able to see the week before.

Snapshotting `D:` whole also broke the path mapping: the snapshot holds
`PoolPart.<guid>\Tier1\...` while the catalog strips that folder from a pool part's
paths, so every file in a perfectly good backup read as missing. Expectations gained a
**snapshot path prefix** for it. Write `PoolPart.*` and the wildcard resolves against the
snapshot itself, so the pool GUID never enters the settings and the rule survives
DrivePool being removed and re-added to a disk.

The full mapping for your layout is written out in
[docs/BACKUP-EXPECTATIONS.md](docs/BACKUP-EXPECTATIONS.md) as a table you can work
straight down. The HDD pool needs one rule per *pool part* rather than one for the pool,
since verification works from catalogued roots; the rules are otherwise identical.

You also mentioned individual disks outside the pool needing cataloguing and hashing.
`D:`, `E:`, `F:` are already in `docker-compose.yml` as SSD-pool members; add `G:` (and
anything else) as a `disk` root if you want it catalogued too.

### 5c. `rxpcc perf` output — **answered**

Your output showed the defensive parser was looking for the wrong thing entirely. There
is no hit rate, no hits and no misses anywhere in it. It is a block per cached volume,
keyed the way `rxpcc ls` numbers them, counting bytes moved:

```
Volume #8:
  Total Read            : 657.49MB
  Cached Read           : 142.91MB (21.7%)
  Total Write (Req)     : 69.88MB
  Total Write (L1/L2)   : 39.25MB / 30.63MB
  Total Write (Disk)    : 54.48MB (78.0%)
```

So the read hit rate is the share beside **Cached Read**. The write figure is the trap:
`Total Write (Disk) 78.0%` is how much still *reached* the disk, which is the inverse of
what the cache absorbed — reporting it as a write hit rate would have said the cache was
helping most exactly when it was helping least. It is carried as "writes absorbed" (22%
for volume #8, 72% for #14, which is taking the write load).

`perf` is per volume, `status` is per cache task, and only `ls` knows which volume
belongs to which task, so the three are joined. Task rates are recomputed from the summed
byte counts rather than averaged from the percentages — otherwise an idle volume's 0.0%
would drag down a busy one's 90%. The drives page shows both levels: per cache task, and
per volume with prefetch progress.

Two details worth knowing: every figure is cumulative since **Stat Start Time**, not a
rate, so the page says since when; and the agent now runs `perf -a`, because without it
only one volume comes back. Your unused cache is 121 GB of L1 and 74 GB of L2.

### 5d. Multiple agents — **closed**

You clarified this meant multiple agents working in parallel, and that the deadline for
it has passed. Nothing to do.

---

## 6. How the pool view works now

You asked for the pool to be virtual, built from the joined disk data, with no separate
catalogue or hash. That is what it does.

Only member disks are scanned. The pool is derived as their union, deduplicated by
pool-relative path (the `PoolPart.<guid>` prefix is stripped), and appears in the catalog
browser, search, the storage map and the totals under the id `pool:<poolId>` like any
other root.

It is also strictly better than scanning the pooled drive would have been:

- **Duplication is observed, not assumed.** The number of disks holding a path *is* its
  duplication, so the storage map shows what the pool really spends rather than what the
  rule asks for — and the gap between the two is the under-duplication report.
- **"Missing" means missing.** A file deleted from one disk but still on another has not
  been lost. Only a path with no surviving copy anywhere counts, which is the list you
  want after a disk dies.
- **Half the I/O**, which is the scarce resource here.

Verified end to end in the container: two member disks holding one duplicated file
produce a three-file pool at the correct effective size; the duplicated file appears once
in a pool search and twice across the raw disks; and after one disk "dies" the pool
reports exactly the one file that had no second copy, while the duplicated one is still
served.

### Copies are counted per physical disk

You were right to push on this, and it was a real hole. DrivePool's duplication setting
is a promise about *drives*: at 2x, the two copies are supposed to land on two different
disks, because one disk dying must not take both. The code was counting **pool parts**,
which gives the same answer only while every part happens to sit on its own drive.

Where it broke: add two partitions of one drive to a pool and DrivePool will write "two
copies", both on that drive. Part-counting would have called the file duplicated and the
disk-loss report would have called it safe. Losing the drive loses it.

Every pool-part root is now resolved to the physical disk behind it — the agent already
reports this with the pool inventory — and copies are counted as *distinct disks*:

- the pool view, the under-duplication report and the disk-loss report all count disks;
- a disk's failure domain is every part on it, so the DR report excludes all of them when
  looking for a surviving copy, and counts a path once even if it is on two of them;
- **two parts of a pool on one physical disk raises a critical alert of its own.** No
  amount of re-balancing fixes it — the pool has nowhere else to put the copies until one
  of those parts is removed or moved to another drive. Worth knowing before you need it.

A part whose disk the agent cannot determine stays its own failure domain. Assuming two
unknowns were the same drive would report healthy data as lost; the opposite mistake is
exactly what the alert above catches.

Your current layout is fine — each pool member is a separate drive — so this changes
nothing today. It changes what happens the day someone adds a second partition.

---

## 7. Decisions worth a glance

| Decision | Why |
| --- | --- |
| Port **8099** | Continues your 8096/8097/8098 block. Confirm with `ss -ltnp`. |
| Data at `/mnt/m/Tier2/Docker/sakuradrive_data` | Matches the convention in your other stacks. |
| Exports to `/mnt/d/SakuraDriveExports` | `D:\` is already in your Kopia repository, so bundles reach Backblaze with the next snapshot. That is the whole point — the catalog has to outlive the machine holding it. |
| Pool mounts read-only | This tool never writes to your data. |
| An unreadable root skips the scan and alarms | A missing bind mount would otherwise mark the entire catalog deleted. A mass deletion raises its own critical alert too. |
| Removing a root keeps its catalog | A root deleted by accident must not take the record of what was on that disk with it. Purging is a separate, explicit action. |
| Credentials redacted from export bundles | They are written outside the app and end up in cloud storage. |

---

## 8. State

707 tests green: 577 Node (163 shared, 377 server, 37 UI) and 130 Pester for the agent.
The `dpcmd` and `rxpcc` parsers are tested against your pasted output verbatim, and the
contract fixture the server test consumes is generated by the agent's own parsers from
that same output — so a change on either side that breaks the protocol fails CI.

Verified by running the container, not just by tests: image build, first-run setup,
catalog scan with duplication-aware sizes, hashing, treemap, export bundle, bit-rot
detection raising and clearing its alert, and the whole pool-view and disk-loss flow
described in §6.

The Pester suite now runs here too, not just in CI: 130 tests against the real `dpcmd`,
`rxpcc status`, `rxpcc ls` and `rxpcc perf -a` output you pasted.

Not verified, because I have no access: real Windows cmdlets and smartctl against your
controllers, a live Kopia repository, whether WSL2's drvfs follows a folder mount point
into another volume (§5a says how to check in one command), and `drvfs` throughput — the
first scan will tell you that last one.

---

## 9. Where things are

```
packages/shared   schedule maths, duplication resolution, treemap layout, glob
                  matching, SMART rules, the agent protocol, the settings schema
packages/server   Fastify API, SQLite, the workflow engine, the collectors
packages/web      React interface
agent             PowerShell agent, installer, Pester tests, contract fixture generator
docker            Dockerfile and compose file, with your real mounts
docs              architecture, agent setup, disaster-recovery runbook, API reference
```

`docs/AGENT.md` now covers the letterless-disk mount points, the real `dpcmd` formats and
the `rxpcc` caveats. `docs/DISASTER-RECOVERY.md` is the one to read before you need it.
