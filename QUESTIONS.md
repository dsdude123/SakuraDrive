# Morning notes

*Updated after your comments on the handover.* Everything you flagged is either done or
answered below. Two things are still open, and one of them is new — it came out of your
own `rxpcc ls` output rather than anything I guessed.

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

### 5b. Say what belongs in Backblaze

Your Kopia sources are visible (`Administrator@tokyo-3:C:\Users`,
`Administrator@tokyo-3:D:\`, and so on), but which pool paths you *expect* to be
protected is a policy decision only you can make. Nothing is reported as unprotected
until at least one expectation rule exists.

Given your tiering, the natural shape is one rule per tier — for example Tier1 and Tier2
expected in the repository, Tier3 and Tier4 deliberately not. Tell me the split and I
will write the rules.

You also mentioned individual disks outside the pool needing cataloguing and hashing.
`D:`, `E:`, `F:` are already in `docker-compose.yml` as SSD-pool members; add `G:` (and
anything else) as a `disk` root if you want it catalogued too.

### 5c. Paste `rxpcc perf` output

`status` and `ls` are parsed exactly against your output. `perf` is the one command
RomexSoftware does not document, so its parser reads defensively: it picks up any label
mentioning hits, misses or a rate, and if your version's wording does not match it
reports **no** hit rate plus a note, rather than a confidently wrong number.

Run `rxpcc perf` with the GUI closed and send the output, and I will match it exactly.

### 5d. Still open from the original brief

**"Use workflows to implement different features."** I read this as an internal workflow
engine — start on demand, stop on demand, progress, pause at the window edge and resume
from a cursor. If you meant something else, say so; the engine is one file and the six
workflows around it are ~150 lines each.

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

644 tests green: 566 Node (163 shared, 366 server, 37 UI) and 78 Pester for the agent.
The `dpcmd` and `rxpcc` parsers are tested against your pasted output verbatim, and the
contract fixture the server test consumes is generated by the agent's own parsers from
that same output — so a change on either side that breaks the protocol fails CI.

Verified by running the container, not just by tests: image build, first-run setup,
catalog scan with duplication-aware sizes, hashing, treemap, export bundle, bit-rot
detection raising and clearing its alert, and the whole pool-view and disk-loss flow
described in §6.

Not verified, because I have no access: real Windows cmdlets and smartctl against your
controllers, a live Kopia repository, and WSL2 `drvfs` throughput — the first scan will
tell you that last one.

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
