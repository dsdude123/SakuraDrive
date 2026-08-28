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

# --- Pool parts, as dpcmd prints them -----------------------------------------
$poolPartLines = @(
    'dpcmd - StableBit DrivePool command line interface',
    'Version 2.3.8.1600',
    '',
    'Listing pool parts for P:\ ...',
    '  Pool part: E:\PoolPart.6a41b3c0-1f2e-4d5a-9b8c-0d1e2f3a4b5c',
    '    Name: DRIVEPOOL27',
    '    Total: 12.7 TB',
    '    Free: 3.6 TB',
    '  Pool part: F:\PoolPart.7b52c4d1-2e3f-4a5b-8c9d-1e2f3a4b5c6d',
    '    Name: DRIVEPOOL28',
    '    Total: 12.7 TB',
    '    Free: 900 GB'
)
$parts = ConvertFrom-DpcmdPoolParts -Lines $poolPartLines
$parts[0].physicalDiskId = '\\.\PHYSICALDRIVE3'
$parts[1].physicalDiskId = '\\.\PHYSICALDRIVE4'

$duplication = Select-ChangedDuplicationRules -PoolId '{hdd-pool}' -Map @{
    ''                = 1
    'Media'           = 2
    'Media/Movies'    = 2
    'Media/Movies/4K' = 3
    'Backups'         = 3
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
        driveLetter = 'P'; path = 'P:\'; fileSystem = 'Covefs'; fileSystemLabel = 'HDD Pool'
        sizeBytes = 28000000000000; freeBytes = 3959207528857; healthStatus = 'Healthy'
        operationalStatus = 'OK'; dirty = $false; physicalDiskIds = @()
    }
)

$pools = @(
    [ordered]@{
        poolId = '{hdd-pool}'; name = 'HDD Pool'; driveLetter = 'P'
        sizeBytes = 28000000000000; freeBytes = 3959207528857
        duplicatedBytes = $null; unduplicatedBytes = $null
        parts = @($parts)
    }
)

$primoCache = [ordered]@{
    available = $false
    version   = $null
    reason    = 'PrimoCache is installed but exposes no command line interface this agent can read.'
    caches    = @()
}

$report = New-AgentReport -Hostname 'NAS-01' -IntervalSeconds 900 `
    -PhysicalDisks $physicalDisks -Volumes $volumes -Smart $smart -Pools $pools `
    -Duplication $duplication -Performance $performance -PrimoCache $primoCache `
    -Errors @(New-CollectorError -Collector 'primocache' -Message 'No command line interface found')

# The timestamp is fixed so the fixture does not churn on every regeneration.
$report.collectedAt = '2024-03-05T03:15:00.000Z'

$directory = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Host "Wrote $OutputPath"
