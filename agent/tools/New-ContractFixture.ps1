<#
.SYNOPSIS
    Generate the agent report fixture the server's contract test consumes.

.DESCRIPTION
    The fixture is built by the agent's own parsing functions from representative
    smartctl and dpcmd output, so the server test is checking the shape the agent
    actually produces rather than a hand-written approximation of it. Re-run this
    after changing anything in SakuraDrive.Agent.psm1 that affects the report shape.

.EXAMPLE
    pwsh -File agent/tools/New-ContractFixture.ps1 -OutputPath packages/server/src/test/fixtures/agent-report.json
#>
[CmdletBinding()]
param(
    [string] $OutputPath = (Join-Path $PSScriptRoot '..' '..' 'packages' 'server' 'src' 'test' 'fixtures' 'agent-report.json')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot '..' 'SakuraDrive.Agent.psm1') -Force

# --- A spinning pool disk, as smartctl reports it -----------------------------
$ataJson = @'
{
  "device": { "name": "/dev/sdd", "type": "sat", "protocol": "ATA" },
  "model_name": "WDC WD140EDGZ-11B1PA0",
  "serial_number": "WD-ABC123",
  "firmware_version": "85.00A85",
  "rotation_rate": 7200,
  "smart_support": { "available": true, "enabled": true },
  "smart_status": { "passed": true },
  "temperature": { "current": 37 },
  "power_on_time": { "hours": 28451 },
  "power_cycle_count": 63,
  "ata_smart_attributes": {
    "table": [
      { "id": 5, "name": "Reallocated_Sector_Ct", "value": 100, "worst": 100, "thresh": 10,
        "when_failed": "", "raw": { "value": 0, "string": "0" } },
      { "id": 9, "name": "Power_On_Hours", "value": 61, "worst": 61, "thresh": 0,
        "when_failed": "", "raw": { "value": 28451, "string": "28451" } },
      { "id": 197, "name": "Current_Pending_Sector", "value": 100, "worst": 100, "thresh": 0,
        "when_failed": "", "raw": { "value": 2, "string": "2" } },
      { "id": 199, "name": "UDMA_CRC_Error_Count", "value": 200, "worst": 200, "thresh": 0,
        "when_failed": "", "raw": { "value": 0, "string": "0" } }
    ]
  },
  "ata_smart_self_test_log": {
    "standard": {
      "table": [
        { "type": { "string": "Extended offline" },
          "status": { "string": "Completed without error", "passed": true },
          "lifetime_hours": 28100 }
      ]
    }
  }
}
'@

# --- The PrimoCache SSD, as an NVMe device ------------------------------------
$nvmeJson = @'
{
  "device": { "name": "/dev/pd1", "type": "nvme", "protocol": "NVMe" },
  "model_name": "Samsung SSD 990 PRO 2TB",
  "serial_number": "S6Z1NJ0T900001",
  "firmware_version": "4B2QJXD7",
  "smart_status": { "passed": true },
  "power_on_time": { "hours": 9120 },
  "nvme_smart_health_information_log": {
    "critical_warning": 0,
    "temperature": 316,
    "available_spare": 100,
    "available_spare_threshold": 10,
    "percentage_used": 7,
    "media_errors": 0,
    "num_err_log_entries": 3,
    "data_units_read": 4210000,
    "data_units_written": 9880000,
    "unsafe_shutdowns": 11
  }
}
'@

$smart = @(
    (ConvertFrom-SmartctlJson -Smart ($ataJson | ConvertFrom-Json)),
    (ConvertFrom-SmartctlJson -Smart ($nvmeJson | ConvertFrom-Json))
)

# --- Pool parts, exactly as DrivePool 2.3.13 prints them ----------------------
$poolPartLines = @'
dpcmd - StableBit DrivePool command line interface

Version 2.3.13.1687

 + Pool ID 'd304fce8-5935-49cb-a280-e93bf43d12bd':
  - '\\?\GLOBALROOT\Device\HarddiskVolume8\PoolPart.a546b1c2-8af0-47a5-b2ee-d5eeadb98481' [Device 4]
  - '\\?\GLOBALROOT\Device\HarddiskVolume10\PoolPart.e83fad5b-1e0d-4101-b337-b308443ca478' [Device 5]
'@ -split "`r?`n"

$parts = ConvertFrom-DpcmdPoolParts -Lines $poolPartLines

# Resolve them against the volumes below, the way the agent does on the host.
$partVolumes = @(
    [pscustomobject]@{ driveLetter = $null; label = 'DRIVEPOOL4'; volumeId = 'vol-e'; fileSystem = 'NTFS'
        sizeBytes = 8000000000000; freeBytes = 292000000000; path = '\\?\Volume{aaaa}\'
        mountPoints = @('C:\PoolDisks\DRIVEPOOL4\'); physicalDiskIds = @('\\.\PHYSICALDRIVE3') },
    [pscustomobject]@{ driveLetter = $null; label = 'DRIVEPOOL9'; volumeId = 'vol-f'; fileSystem = 'NTFS'
        sizeBytes = 8000000000000; freeBytes = 292000000000; path = '\\?\Volume{bbbb}\'
        mountPoints = @('C:\PoolDisks\DRIVEPOOL9\'); physicalDiskIds = @('\\.\PHYSICALDRIVE4') }
)
# Mounted into folders, not lettered - as on an array with more disks than letters.
$partLetters = @{ 'PoolPart.a546b1c2-8af0-47a5-b2ee-d5eeadb98481' = 'C:\PoolDisks\DRIVEPOOL4'
    'PoolPart.e83fad5b-1e0d-4101-b337-b308443ca478' = 'C:\PoolDisks\DRIVEPOOL9' }
$parts = Resolve-PoolPartVolume -Parts $parts -Volumes $partVolumes -TestPath {
        param($path)
        foreach ($entry in $partLetters.GetEnumerator()) {
            if ($path -eq "$($entry.Value)\$($entry.Key)") { return $true }
        }
        $false
    }

# --- Duplication, from real `get-duplication` output --------------------------
$tier1 = ConvertFrom-DpcmdDuplication -Lines (@'
Found '\\?\J:\Tier1\'

  Expected number of copies: 2
  Found number of copies: 14
  Is directory: True
  Has multiple sub-duplication counts: False
'@ -split "`r?`n")

$duplication = Select-ChangedDuplicationRules -PoolId 'd304fce8-5935-49cb-a280-e93bf43d12bd' -Map @{
    ''      = 1
    'Tier1' = $tier1
    'Tier2' = 2
    'Tier3' = 1
}

$performance = @(
    (ConvertTo-PerformanceSample -Instance '3 E:' -ReadSeconds 0.0042 -WriteSeconds 0.0031 `
        -QueueLength 0.4 -ReadBytesPerSec 41000000 -WriteBytesPerSec 12000000 -IdlePercent 71.5),
    (ConvertTo-PerformanceSample -Instance '4 F:' -ReadSeconds 0.9120 -WriteSeconds 0.7400 `
        -QueueLength 44.2 -ReadBytesPerSec 900000 -WriteBytesPerSec 400000 -IdlePercent 2.1)
)

$physicalDisks = @(
    [ordered]@{
        deviceId = '\\.\PHYSICALDRIVE3'; friendlyName = 'WDC WD140EDGZ-11B1PA0'
        model = 'WDC WD140EDGZ-11B1PA0'; serialNumber = 'WD-ABC123'; firmwareVersion = '85.00A85'
        sizeBytes = 14000519643136; mediaType = 'HDD'; busType = 'SATA'
        healthStatus = 'Healthy'; operationalStatus = 'OK'; physicalLocation = 'Bay 7'
        adapterSerialNumber = ''; temperatureC = 37
    },
    [ordered]@{
        deviceId = '\\.\PHYSICALDRIVE4'; friendlyName = 'WDC WD140EDGZ-11B1PA0'
        model = 'WDC WD140EDGZ-11B1PA0'; serialNumber = 'WD-DEF456'; firmwareVersion = '85.00A85'
        sizeBytes = 14000519643136; mediaType = 'HDD'; busType = 'SATA'
        healthStatus = 'Healthy'; operationalStatus = 'OK'; physicalLocation = 'Bay 8'
        adapterSerialNumber = ''; temperatureC = 39
    },
    [ordered]@{
        deviceId = '\\.\PHYSICALDRIVE1'; friendlyName = 'Samsung SSD 990 PRO 2TB'
        model = 'Samsung SSD 990 PRO 2TB'; serialNumber = 'S6Z1NJ0T900001'; firmwareVersion = '4B2QJXD7'
        sizeBytes = 2000398934016; mediaType = 'SSD'; busType = 'NVMe'
        healthStatus = 'Healthy'; operationalStatus = 'OK'; physicalLocation = 'M.2 slot 1'
        adapterSerialNumber = ''; temperatureC = 43
    }
)

$volumes = @(
    [ordered]@{
        volumeId = '\\?\Volume{11111111-1111-1111-1111-111111111111}\'; label = 'DRIVEPOOL27'
        driveLetter = 'E'; path = 'E:\'; fileSystem = 'NTFS'; fileSystemLabel = 'DRIVEPOOL27'
        sizeBytes = 14000000000000; freeBytes = 3958241161216; healthStatus = 'Healthy'
        operationalStatus = 'OK'; dirty = $false; physicalDiskIds = @('\\.\PHYSICALDRIVE3')
    },
    [ordered]@{
        volumeId = '\\?\Volume{22222222-2222-2222-2222-222222222222}\'; label = 'DRIVEPOOL28'
        driveLetter = 'F'; path = 'F:\'; fileSystem = 'NTFS'; fileSystemLabel = 'DRIVEPOOL28'
        sizeBytes = 14000000000000; freeBytes = 966367641; healthStatus = 'Healthy'
        operationalStatus = 'OK'; dirty = $true; physicalDiskIds = @('\\.\PHYSICALDRIVE4')
    },
    [ordered]@{
        volumeId = '\\?\Volume{33333333-3333-3333-3333-333333333333}\'; label = 'SSDPOOL1'
        driveLetter = 'G'; path = 'G:\'; fileSystem = 'NTFS'; fileSystemLabel = 'SSDPOOL1'
        sizeBytes = 2000000000000; freeBytes = 1200000000000; healthStatus = 'Healthy'
        operationalStatus = 'OK'; dirty = $false; physicalDiskIds = @('\\.\PHYSICALDRIVE1')
    },
    [ordered]@{
        volumeId = '\\?\Volume{44444444-4444-4444-4444-444444444444}\'; label = 'HDD Pool'
        # NTFS: that is what Windows reports for a DrivePool volume, driver name or not.
        driveLetter = 'P'; path = 'P:\'; fileSystem = 'NTFS'; fileSystemLabel = 'HDD Pool'
        sizeBytes = 28000000000000; freeBytes = 3959207528857; healthStatus = 'Healthy'
        operationalStatus = 'OK'; dirty = $false; physicalDiskIds = @()
    }
)

$pools = @(
    [ordered]@{
        poolId = 'd304fce8-5935-49cb-a280-e93bf43d12bd'; name = 'DrivePool'; driveLetter = 'J'
        sizeBytes = 28000000000000; freeBytes = 3959207528857
        duplicatedBytes = $null; unduplicatedBytes = $null
        parts = @($parts)
    }
)

# --- PrimoCache, from real `rxpcc status` and `rxpcc ls` output ----------------
$rxpccStatus = @'
Cache Task #1 {507EEFF9-B281-489B-914F-F402D497E55E}
----------------------------------------------------
  Status: Active
  Level-1 Cache: 262144MB
    MM: 262144MB, IM: 0MB
  Level-2 Cache: 953618MB
    Storage: {D4CEAE5C-9802-4DB5-9510-6B6CCBEF8D2F}
  Block Size: 32KB
  Strategy: Read & Write
  Defer-Write: Enabled
    Latency: 300s
  Overhead: 12.48GB

Volume #8: Cache (Active)
  Strategy: Read & Write
'@ -split "`r?`n"

$rxpccLs = @'
Volume List
===========

Index      Name                   FileSys  Free/Capacity         Cluster  Cache
-------------------------------------------------------------------------------
Disk4      ATA     ST8000VN004-3CP1        7452.04GB
  Vol #8   DRIVEPOOL4             NTFS     272.14GB/7452.02GB    4KB      1

Disk5      ATA     ST8000VN004-3CP1        7452.04GB
  Vol #10  DRIVEPOOL9             NTFS     272.29GB/7452.02GB    4KB      1
'@ -split "`r?`n"

# Real `rxpcc perf -a` output. It is per volume and speaks in bytes moved, so the cache
# task's rates are the summed byte counts of the volumes it fronts.
$rxpccPerf = @'
Volume #8:
  Total Read            : 657.49MB
  Cached Read           : 142.91MB (21.7%)
  L2Storage Read        : 47.74MB (7.3%)
  L2Storage Write       : 51.17GB
  Total Write (Req)     : 69.88MB
  Total Write (L1/L2)   : 39.25MB / 30.63MB
  Total Write (Disk)    : 54.48MB (78.0%)
    Urgent/Normal       : 0 / 54.48MB
  Deferred Blocks       : 15 (0.0%)
  Trimmed Blocks        : 139
  Prefetch              : Done (16.96GB / 19.40GB)
  Unused Cache (L1)     : 121.12GB
  Unused Cache (L2)     : 74.02GB
  Stat Start Time       : 2026-08-28 12:41:15

Volume #10:
  Total Read            : 584.55MB
  Cached Read           : 15.92MB (2.7%)
  L2Storage Read        : 0 (0.0%)
  L2Storage Write       : 0
  Total Write (Req)     : 6.84MB
  Total Write (L1/L2)   : 2.11MB / 4.73MB
  Total Write (Disk)    : 3.62MB (52.9%)
    Urgent/Normal       : 0 / 3.62MB
  Deferred Blocks       : 9 (0.0%)
  Trimmed Blocks        : 0
  Prefetch              : Done (11.78GB / 27.82GB)
  Unused Cache (L1)     : 121.12GB
  Unused Cache (L2)     : 74.02GB
  Stat Start Time       : 2026-08-28 12:41:16
'@ -split "`r?`n"

$primoCache = Join-PrimoCacheReport `
    -Caches (ConvertFrom-RxpccStatus -Lines $rxpccStatus) `
    -Volumes (ConvertFrom-RxpccVolumeList -Lines $rxpccLs) `
    -Perf (ConvertFrom-RxpccPerf -Lines $rxpccPerf) `
    -Version '4.3.0'

$report = New-AgentReport -Hostname 'NAS-01' -IntervalSeconds 900 `
    -PhysicalDisks $physicalDisks -Volumes $volumes -Smart $smart -Pools $pools `
    -Duplication $duplication -Performance $performance -PrimoCache $primoCache `
    -Errors @()

# The timestamp is fixed so the fixture does not churn on every regeneration.
$report.collectedAt = '2024-03-05T03:15:00.000Z'

$directory = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Host "Wrote $OutputPath"
