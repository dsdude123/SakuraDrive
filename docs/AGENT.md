# The Windows agent


## PowerShell version

Everything under `agent/` runs on **Windows PowerShell 5.1**, which is what ships with
Windows Server. PowerShell 7 is not required and is not assumed anywhere.

Two things keep it that way, because neither is obvious by reading:

- **The files are pure ASCII.** Windows PowerShell 5.1 reads a `.ps1` as the ANSI
  codepage unless the file has a UTF-8 BOM. On a Western install that is Windows-1252,
  where a UTF-8 em dash arrives as three characters, the last of which is a smart closing
  quote — and PowerShell accepts smart quotes as string delimiters, so the string ends
  early and the rest of the file will not parse. A Pester test asserts every file is
  ASCII and reads identically under both encodings.
- **CI checks the cmdlet surface** with PSScriptAnalyzer against a real Server 2019 /
  5.1 profile, so a parameter that only exists in a newer Storage module fails the build
  rather than the host.

## Why it exists

SMART attributes, volume labels, the NTFS dirty bit, StableBit DrivePool's configuration
and PrimoCache statistics are all Windows-side and cannot be read from inside a Linux
container. The agent collects them and posts a JSON report to the server.

Everything else — the file catalog, hashing, the storage map, backup verification —
works without it. Install it and you additionally get drive health, per-drive alerts
named by the label on the caddy, pool membership, real duplication settings and I/O
latency monitoring.

## Install

1. In the web interface, go to **Settings → Agents** and create a token. It is shown
   once.
2. Copy the `agent` folder to the Windows host.
3. From an **elevated** PowerShell prompt:

```powershell
cd C:\path\to\agent
.\Install-SakuraDriveAgent.ps1 -ServerUrl http://nas.local:8080 -Token <the token>
```

That copies the agent to `C:\Program Files\SakuraDrive Agent`, writes its configuration
with an ACL that only SYSTEM and Administrators can read (the token is a credential),
registers a scheduled task running as SYSTEM every 15 minutes plus once at boot, and runs
it once so you can confirm it worked.

Elevation is required because reading SMART data and querying DrivePool both need
administrative rights, and SYSTEM is used so the task keeps running when you log out.

Useful switches:

```powershell
-IntervalMinutes 30            # default 15
-InstallPath 'D:\Tools\Agent'
-Uninstall                     # removes the task and the installed files
```

## Full SMART attributes

Install [smartmontools for Windows](https://www.smartmontools.org/wiki/Download). The
agent finds `smartctl.exe` automatically in the usual install locations, or set
`SmartctlPath` in `agent.config.json`.

Without it the agent falls back to `Get-StorageReliabilityCounter`, which gives
temperature, power-on hours, wear and uncorrected error counts — enough to catch a drive
in trouble, but no per-attribute table and no reallocated/pending sector counts, which
are the numbers that actually predict failure.

If smartctl reports no devices on a RAID or USB controller, it usually needs an explicit
device type. Find the right one with `smartctl --scan-open` and `smartctl -d <type> -a`,
then note it: the agent currently passes through the type from `--scan-open`, so if that
scan is wrong for your controller the drive is skipped and the reason appears under
**Settings → Agents**.

## Pool disks without drive letters

An array with more disks than there are drive letters mounts its members without one.
On tokyo-3 the fourteen HDD pool members are letterless, which has two consequences:

- **The agent handles it already.** It finds each `PoolPart.*` folder by trying the
  volume's drive letter, then its folder mount points, then its volume GUID path, and
  reports the mount points it found so the interface can show them.
- **The container cannot see them.** WSL2 only surfaces lettered drives under
  `/mnt/<letter>`, so a letterless disk cannot be bind-mounted and therefore cannot be
  catalogued or hashed.

`agent/tools/Set-PoolDiskMountPoints.ps1` does the whole job. Look first — this needs no
elevation and changes nothing:

```powershell
.\Set-PoolDiskMountPoints.ps1 -ListOnly

#   #  Label            Ltr  FS     Size     Status    Reachable from WSL as
#   1  DRIVEPOOL4       -    NTFS   7.3 TB   unmounted NOT VISIBLE
#   2  Recovery         -    NTFS   450 MB   reserved  NOT VISIBLE
#   3  SSDPool          M:   NTFS   2.7 TB   letter    /mnt/m
```

Then give the disks you pick a drive letter each:

```powershell
.\Set-PoolDiskMountPoints.ps1 -AssignDriveLetter
```

Pick by number, by range (`4-9`), or `all`; the candidates are suggested for you. It
refuses to touch the system volume *and* Windows' own recovery and reserved partitions,
which look exactly like small unmounted data disks in the listing and would otherwise be
offered alongside the pool members. It verifies each change took rather than assuming it,
and prints the `/mnt/<letter>` and the docker-compose line for everything it changed.

`-WhatIf` shows the plan and writes nothing. `-Label` and `-All` script it. `-Remove`
undoes a folder mount point — the volume and its contents are untouched, only the path
you reach it by goes away.

Without `-AssignDriveLetter` the script creates a **folder mount point** instead, under
`-MountRoot` (default `C:\PoolDisks`). That is the classic answer to the 26-letter limit
and works fine on Windows — but not for this container, for the reason below.

### Folder mount points do not work for the container

Mount points survive reboots and are fine on Windows, but **WSL2 cannot use them**.
drvfs will not cross a reparse point into another volume:

```
$ ls /mnt/c/PoolDisks/DRIVEPOOL16
ls: cannot access '/mnt/c/PoolDisks/DRIVEPOOL16': Input/output error
```

That is drvfs refusing the traversal, not a permission or timing problem, and it does
not vary by disk — measured on this host after mounting all fourteen. So a folder mount
point makes a volume reachable from Windows and *not* from a container, which is the
opposite of what is needed here.

**Give the volumes drive letters instead.** A lettered volume appears at `/mnt/<letter>`
with no traversal involved, which is the only arrangement WSL2 supports:

```powershell
.\Set-PoolDiskMountPoints.ps1 -AssignDriveLetter
```

Same picker, same refusals; it allocates the next free letter to each volume you select,
skipping A, B and anything already in use, and reports the `/mnt/<letter>` each one lands
on. Letters are allocated up front, so if there are not enough it stops before touching
anything rather than lettering half the pool and failing. This host has 19 free and
needs 14.

The agent itself needs none of this: it probes drive letters, folder mount points *and*
volume GUID paths, so SMART, pool membership and duplication already work on a letterless
disk. Only the container's bind mounts need the letter.

The volumes page shows each volume's mount point, or "not mounted" when it has neither
a letter nor a folder — which is exactly the set of disks that still need this.

## DrivePool

`dpcmd.exe` ships with StableBit DrivePool and is found automatically. The agent uses it
for two things.

**Pool membership**, from `dpcmd list-poolparts <pool>`:

```
 + Pool ID 'd304fce8-5935-49cb-a280-e93bf43d12bd':
  - '\\?\GLOBALROOT\Device\HarddiskVolume8\PoolPart.a546b1c2-...' [Device 4]
```

That gives the real pool GUID, but identifies each part only by NT device path — no
letter, no label, no capacity. The agent resolves each one by finding which volume
actually holds that `PoolPart.<guid>` folder. A part no volume on the host holds is a
disk that has dropped out, and is reported as missing.

**Duplication settings**, from `dpcmd get-duplication <folder>`:

```
Found '\\?\J:\Tier1\'
  Expected number of copies: 2
  Found number of copies: 14
  Is directory: True
  Has multiple sub-duplication counts: False
```

`Expected number of copies` is the configured level. `Has multiple sub-duplication
counts: False` means everything below the folder shares that level, so the probe stops
there instead of walking further — which on a tier-based layout turns a full tree walk
into a handful of calls. `Found number of copies` is only a real copy count for a file;
for a directory it counts how many pool parts have that folder, which on a 14-disk pool
reads as 14 whatever the duplication setting is, so it is not treated as one.

Without `dpcmd`, pool parts are still discovered from the `PoolPart.*` folders DrivePool
creates at the root of each member disk, and duplication levels can be entered by hand
under **Settings → Duplication**.

`DuplicationDepth` (default 3) bounds how far the probe descends when a folder *does*
report mixed sub-counts. With duplication set per tier, the default is more than enough.

## Configuration

`C:\Program Files\SakuraDrive Agent\agent.config.json`:

| Key | Default | Notes |
| --- | --- | --- |
| `ServerUrl` | — | Base URL of the web interface |
| `Token` | — | From Settings → Agents |
| `IntervalSeconds` | 900 | Also set on the scheduled task by the installer |
| `SmartctlPath` | auto | Explicit path to `smartctl.exe` |
| `DpcmdPath` | auto | Explicit path to `dpcmd.exe` |
| `DuplicationDepth` | 3 | Folder levels to probe for duplication settings |
| `PerformanceSamples` | 3 | Seconds of performance-counter sampling per report |
| `CollectSmart` / `CollectPerformance` / `CollectDrivePool` / `CollectPrimoCache` | true | Turn individual collectors off |
| `SkipCertificateCheck` | false | Only for a self-signed certificate on a trusted LAN |
| `TimeoutSeconds` | 120 | HTTP timeout |
| `LogPath` | `C:\ProgramData\SakuraDrive\agent.log` | Blank disables file logging |

## Checking what it can see

```powershell
.\SakuraDriveAgent.ps1 -DryRun | Out-File report.json
```

Collects everything and prints the report without posting it. The `errors` array names
every collector that could not run and why — that same list appears under
**Settings → Agents** in the web interface, so a collector that is failing is visible
rather than looking like healthy silence.

To run it in the foreground instead of via the scheduled task:

```powershell
.\SakuraDriveAgent.ps1 -Loop
```

## PrimoCache

PrimoCache ships `rxpcc.exe`, and the agent uses it. It is found automatically at
`C:\Program Files\PrimoCache\rxpcc.exe`, or set `RxpccPath`.

Three commands are read:

| Command | What it gives |
| --- | --- |
| `rxpcc status` | Cache tasks: L1 and L2 sizes, block size, strategy, defer-write, overhead |
| `rxpcc ls` | Which labelled volumes each cache task fronts |
| `rxpcc perf` | Hit rates |

**The CLI and the GUI cannot run at the same time.** With the PrimoCache window open,
`rxpcc` exits with a "Multiple Instances" error. The agent recognises that specific
condition and reports it as *"The PrimoCache GUI is open"* rather than as a broken
collector — so an open window looks like an open window, not a fault. Statistics resume
on the next report after the GUI is closed. It also needs administrative rights, which
the agent has because the scheduled task runs as SYSTEM.

`status` and `ls` are parsed against known output. `perf` is not publicly documented and
its wording varies by version, so it is read defensively: any label mentioning hits,
misses or a rate is picked up, and a version whose wording is unrecognised yields *no*
hit rate and a note in the collector errors — rather than a confidently wrong number. If
your version reports nothing, send the output of `rxpcc perf` and the parser can be
matched to it exactly.

## Protocol

`POST /api/agent/report` with `Authorization: Bearer <token>`. Every section is optional,
so an agent that could collect nothing still checks in and reports why.

The schema is `agentReportSchema` in `packages/shared/src/agent-protocol.ts`, and
`AGENT_PROTOCOL_VERSION` beside it. The server records the version each agent reports and
warns — without rejecting the data — when it differs from its own.

## Troubleshooting

**Nothing appears under Settings → Agents.** Check the task's last result in Task
Scheduler, then `C:\ProgramData\SakuraDrive\agent.log`. A `401` means the token is wrong
or was revoked.

**The agent reports but there is no SMART data.** Install smartmontools, then re-run with
`-DryRun` and read the `errors` array.

**Drives appear twice.** The agent keys drives by serial number. A controller that
reports a blank or duplicated serial falls back to the device path, which changes when
Windows renumbers the disks. Check `Get-PhysicalDisk | Select FriendlyName, SerialNumber`.

**Pools are missing.** Pool drives are identified by their `Covefs` filesystem. Confirm
with `Get-Volume | Where-Object FileSystemType -match covefs`.
