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

The server ships the agent. Go to **Settings → Agents**, create a token, and paste the
command it shows into an **elevated** Windows PowerShell prompt on the host:

```powershell
$Server = 'http://nas.local:8080'; $Token = '<the token>'
$b = Join-Path $env:TEMP 'Bootstrap-SakuraDriveAgent.ps1'
Invoke-WebRequest -UseBasicParsing -Uri "$Server/api/agent/dist/file?path=Bootstrap-SakuraDriveAgent.ps1" -Headers @{ Authorization = "Bearer $Token" } -OutFile $b
& $b -ServerUrl $Server -Token $Token
```

That downloads one script, which then fetches the rest of the agent, checks every file
against the SHA-256 the server published, parses the PowerShell before running any of it,
and installs. It copies the agent to `C:\Program Files\SakuraDrive Agent`, writes its
configuration with an ACL that only SYSTEM and Administrators can read (the token is a
credential), registers a scheduled task running as SYSTEM every 15 minutes plus once at
boot, and runs it once so you can confirm it worked.

Elevation is required because reading SMART data and querying DrivePool both need
administrative rights, and SYSTEM is used so the task keeps running when you log out.

If the server is on `https` with a self-signed certificate, add `-SkipCertificateCheck`
to the last line. On `https` at all, Windows PowerShell 5.1 needs
`[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12` first;
the interface includes that line when it applies.

Running the command again repairs an installation. Add `-KeepConfig` to keep the existing
`agent.config.json`.

### Installing without the server

Copy the `agent` folder to the host and run the installer directly:

```powershell
cd C:\path\to\agent
.\Install-SakuraDriveAgent.ps1 -ServerUrl http://nas.local:8080 -Token <the token>
```

The agent then works out on its first run that its files match what the server ships, and
keeps itself current from then on.

## Updating

The agent replaces itself with whatever the server is shipping. Deploy a new image (see
[deploying](DEPLOY.md)) and every host picks it up within one interval; there is nothing
to copy onto Windows.

Each run asks `/api/agent/dist` for the current manifest and compares its version — a
hash of the file hashes — with what is installed. When they differ it downloads to a
staging directory, checks every file's SHA-256, parses every `.ps1` and `.psm1`, and only
then swaps them in, keeping the replaced files in `.previous`. `agent.config.json`, the
log and anything else beside the agent are left alone.

Nothing about that is best-effort:

- A hash that does not match, or a file that will not parse, means the update is refused
  and the working agent keeps running. The refusal names the file and the line.
- A version that installs but cannot get through two runs puts the previous files back on
  its own, and is not offered again — the reason appears against the host under
  **Settings → Agents**.
- The update check runs even when the cycle before it failed. An agent too broken to
  report is the one that most needs the fix the server is holding.

`Settings → Agents` shows which distribution each host is running. Set
`"SelfUpdate": false` in `agent.config.json` to pin a host to what it has.

Useful switches:

## Uninstall

```powershell
& 'C:\Program Files\SakuraDrive Agent\Uninstall-SakuraDriveAgent.ps1'
```

It is installed alongside the agent so it is still there when the folder you ran the
installer from is gone. `-WhatIf` shows what it would remove. Logs are kept by default;
`-KeepLogs:$false` removes those too.

Two things it deliberately does not do: the token stays valid until you revoke it under
**Settings → Agents**, and the catalog is untouched — removing the thing that read a disk
should never delete the record of what was on it.

A revoked token disappears from the list after 30 days (`general.revokedTokenDays`),
which is long enough to answer "was that host still reporting after I revoked it?".

## Installer switches

```powershell
-IntervalMinutes 30                          # default 15
-InstallPath 'D:\Tools\Agent'
-SmartctlPath 'C:\Tools\smartctl.exe'        # blank = search the usual places
-DpcmdPath    'C:\Tools\dpcmd.exe'
-RxpccPath    'C:\Tools\rxpcc.exe'
-KeepConfig                                  # re-register the task, keep agent.config.json
-Uninstall                                   # removes the task and the installed files
```

`Bootstrap-SakuraDriveAgent.ps1` takes the same switches and passes them through, plus
`-SkipCertificateCheck` for a self-signed certificate.

## The configuration file

`agent.config.json` lives next to the installed agent and is read on every run, so a
change takes effect at the next report — no reinstall. It is the single source of truth
for everything the agent does; the switches above are just a way to set some of it at
install time.

The installer builds it from the agent's own defaults and overlays what you passed, so
it cannot list a different set of keys from the one the agent reads. `-KeepConfig`
re-registers the task without touching the file, and adds any keys a newer agent
introduced — use it for upgrades once you have tuned something.

A bad configuration fails at install time rather than in a log fifteen minutes later,
and a tool path that does not exist is warned about rather than silently ignored.

`agent.config.example.json` is generated from those same defaults and a test asserts it
still matches, so it cannot go stale.

| Key | What it does |
| --- | --- |
| `ServerUrl`, `Token` | Where to report, and the token from Settings → Agents |
| `IntervalSeconds` | How often to report. 900 is the default |
| `SmartctlPath`, `DpcmdPath`, `RxpccPath` | Explicit tool paths. Blank means search |
| `CollectSmart`, `CollectPerformance`, `CollectDrivePool`, `CollectPrimoCache` | Turn a collector off |
| `CollectCatalogJobs` | Take catalog scan and hash work. Off means health reporting only |
| `SelfUpdate` | Replace the agent with what the server ships. Off pins this host |
| `DuplicationDepth` | How deep to probe DrivePool duplication. 3 suits a tiered layout |
| `PerformanceSamples` | Seconds of performance-counter sampling per report |
| `SkipCertificateCheck` | Only for a self-signed certificate on a trusted LAN |
| `TimeoutSeconds`, `LogPath` | HTTP timeout, and where the agent logs |

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

Mount points are fine on Windows, but **WSL2 cannot use them**. drvfs will not cross a
reparse point into another volume:

```
$ ls /mnt/c/PoolDisks/DRIVEPOOL16
ls: cannot access '/mnt/c/PoolDisks/DRIVEPOOL16': Input/output error
```

That is drvfs refusing the traversal, not a permission or timing problem, and it does not
vary by disk — measured on this host after mounting all fourteen.

### The agent reads every root

Not just the letterless ones — **all of them**. Supporting two paths would mean two sets
of failure modes and a setting nobody should have to think about, and the container has
no path to most of these volumes anyway.

Drive letters are no longer needed for cataloguing at all. `-AssignDriveLetter` still
exists if you want letters for your own reasons, but SakuraDrive does not care either
way.

Configure each root in **Settings → Catalog roots** with the volume GUID path:

```
\\?\Volume{9f3a...}\PoolPart.{d304fce8...}
```

You should not have to type that. The agent reports every pool part it finds with each
poll, and the root editor offers them in a list — pick the label off the caddy and the
path, pool id and drive label are filled in.

The agent then takes catalog scan and hash jobs from the server and streams results back.
The server keeps the schedule, the catalog run, the cursor and the deletion rules, so a
scan pauses at the window edge and resumes where it stopped. `docs/ARCHITECTURE.md`,
"Who reads the disks", has the split in full and the three failure modes.

Set `CollectCatalogJobs` to `false` in `agent.config.json` if you want the agent to
report health only and never take cataloguing work.

The volumes page shows each volume's letter or mount point, or "not mounted" when it has
neither. That is now informational rather than a prerequisite: a volume with no letter at
all is catalogued exactly like one with a letter.

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
| `RxpccPath` | auto | Explicit path to `rxpcc.exe` |
| `CollectCatalogJobs` | true | Take catalog scan and hash work from the server |
| `SelfUpdate` | true | Keep this host on whatever the server ships |
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

Everything the agent calls sits under `/api/agent/` and takes the same bearer token:

| Endpoint | What it is for |
| --- | --- |
| `POST /api/agent/report` | The health report |
| `POST /api/agent/jobs/claim`, `…/:id/batch`, `…/:id/finish` | Catalog work for roots the container cannot read |
| `GET /api/agent/dist` | The manifest: a version, and every file with its SHA-256 |
| `GET /api/agent/dist/file?path=…` | One file, as bytes. Only names in the manifest are served |

## Troubleshooting

**Nothing appears under Settings → Agents.** Check the task's last result in Task
Scheduler, then `C:\ProgramData\SakuraDrive\agent.log`. A `401` means the token is wrong
or was revoked.

**The install said `Last result: 267009`.** That is Task Scheduler for "still
running", not a failure. The first pass reads SMART for every disk and probes every
volume with dpcmd, which takes minutes on a large array. The installer waits for it and
says so in plain words; an older one printed the raw code under "0 means success".

| Code | Means |
| --- | --- |
| `0` | The agent ran and exited cleanly |
| `1` | The agent rejected its configuration |
| `2` | The agent could not post its report |
| `267008` / `267011` | Waiting for its next scheduled run |
| `267009` | Still running |
| `267010` | The task is disabled |
| `267014` | The task was stopped before it finished |

**The agent reports but there is no SMART data.** Install smartmontools, then re-run with
`-DryRun` and read the `errors` array.

**Drives appear twice.** The agent keys drives by serial number. A controller that
reports a blank or duplicated serial falls back to the device path, which changes when
Windows renumbers the disks. Check `Get-PhysicalDisk | Select FriendlyName, SerialNumber`.

**Pools are missing.** A pool is whatever `dpcmd list-poolparts` says is one — the agent
probes each lettered volume with it rather than inspecting the filesystem, because
Windows reports a DrivePool volume as NTFS like any other. Confirm by hand:

```powershell
& 'C:\Program Files\StableBit\DrivePool\dpcmd.exe' list-poolparts J:\
```

If that prints a pool id and the agent still reports none, the output format differs
from the one the parser was built against — send it and the parser can be matched to it.
If dpcmd itself is not found, set `DpcmdPath` in `agent.config.json`.
