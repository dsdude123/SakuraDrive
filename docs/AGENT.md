# The Windows agent

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

## DrivePool

`dpcmd.exe` ships with StableBit DrivePool and is found automatically. The agent uses it
for two things:

- `dpcmd list-poolparts <pool>` for pool membership;
- `dpcmd get-duplication <folder>` to read duplication settings, probed breadth-first to
  `DuplicationDepth` levels (default 3) below each pool root, keeping only folders whose
  level differs from what they inherit.

Without `dpcmd`, pool parts are still discovered from the `PoolPart.*` folders DrivePool
creates at the root of each member disk, and duplication levels can be entered by hand
under **Settings → Duplication**.

Raise `DuplicationDepth` if your duplication rules live deeper than three folders down.
It costs one `dpcmd` call per folder at each level, so keep it as low as covers your
layout.

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

RomexSoftware does not publish a command-line interface or performance counters for
PrimoCache, so there is no supported way to read its statistics programmatically. The
agent looks for a CLI beside the installed product and reports clearly when it finds
none, rather than pretending the cache is absent.

If a future PrimoCache release adds one, the hook is `Get-PrimoCacheInventory` in
`SakuraDriveAgent.ps1` — it expects JSON with a `caches` array, and the shape the server
accepts is in `packages/shared/src/agent-protocol.ts`.

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
