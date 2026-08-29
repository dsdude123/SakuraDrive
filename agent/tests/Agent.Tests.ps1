#Requires -Modules Pester

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'SakuraDrive.Agent.psm1') -Force
}

Describe 'Configuration' {
    It 'produces a complete default configuration' {
        $config = Get-DefaultAgentConfig
        $config.ServerUrl | Should -Be 'http://localhost:8080'
        $config.IntervalSeconds | Should -Be 900
        $config.CollectSmart | Should -BeTrue
        $config.DuplicationDepth | Should -Be 3
    }

    It 'overlays user values onto the defaults' {
        $user = [pscustomobject]@{ ServerUrl = 'https://nas:8443'; Token = 'abc' }
        $merged = Merge-AgentConfig -UserConfig $user
        $merged.ServerUrl | Should -Be 'https://nas:8443'
        $merged.Token | Should -Be 'abc'
        $merged.IntervalSeconds | Should -Be 900
    }

    It 'keeps keys it does not recognise' {
        $user = [pscustomobject]@{ FutureOption = 'keep me' }
        (Merge-AgentConfig -UserConfig $user).FutureOption | Should -Be 'keep me'
    }

    It 'returns defaults when there is no user configuration' {
        (Merge-AgentConfig -UserConfig $null).IntervalSeconds | Should -Be 900
    }

    It 'accepts a valid configuration' {
        $config = Merge-AgentConfig -UserConfig ([pscustomobject]@{
                ServerUrl = 'http://nas:8080'; Token = 'tok'
            })
        (Test-AgentConfig -Config $config).Count | Should -Be 0
    }

    It 'reports every problem with an invalid configuration' {
        $config = Merge-AgentConfig -UserConfig ([pscustomobject]@{
                ServerUrl = 'nas:8080'; Token = ''; IntervalSeconds = 5; DuplicationDepth = 99
            })
        $problems = Test-AgentConfig -Config $config
        $problems.Count | Should -Be 4
        ($problems -join ' ') | Should -Match 'http'
        ($problems -join ' ') | Should -Match 'Token'
    }
}

Describe 'Get-DeviceKey' {
    It 'prefers the serial number, upper-cased' {
        Get-DeviceKey -SerialNumber 'wd-abc123' -DeviceId 'x' | Should -Be 'sn:WD-ABC123'
    }

    It 'falls back to the device id' {
        Get-DeviceKey -SerialNumber '' -DeviceId '\\.\PHYSICALDRIVE3' | Should -Be 'DEV:\\.\PHYSICALDRIVE3'.Replace('DEV', 'dev')
    }

    It 'ignores a literal "unknown" serial' {
        Get-DeviceKey -SerialNumber 'unknown' -DeviceId 'drive0' | Should -Be 'dev:DRIVE0'
    }

    It 'is stable when nothing identifies the drive' {
        Get-DeviceKey | Should -Be 'dev:unknown'
    }
}

Describe 'ConvertTo-PhysicalDrivePath' {
    It 'maps smartctl /dev/sdX names onto PhysicalDrive numbers' {
        ConvertTo-PhysicalDrivePath -Name '/dev/sda' | Should -Be '\\.\PHYSICALDRIVE0'
        ConvertTo-PhysicalDrivePath -Name '/dev/sdc' | Should -Be '\\.\PHYSICALDRIVE2'
        ConvertTo-PhysicalDrivePath -Name '/dev/sdz' | Should -Be '\\.\PHYSICALDRIVE25'
        ConvertTo-PhysicalDrivePath -Name '/dev/sdaa' | Should -Be '\\.\PHYSICALDRIVE26'
    }

    It 'maps /dev/pdN directly' {
        ConvertTo-PhysicalDrivePath -Name '/dev/pd7' | Should -Be '\\.\PHYSICALDRIVE7'
    }

    It 'normalises a device path that is already Windows-shaped' {
        ConvertTo-PhysicalDrivePath -Name '\\.\physicaldrive4' | Should -Be '\\.\PHYSICALDRIVE4'
    }

    It 'passes an unrecognised name through unchanged' {
        ConvertTo-PhysicalDrivePath -Name '/dev/nvme0' | Should -Be '/dev/nvme0'
    }

    It 'returns empty for an empty name' {
        ConvertTo-PhysicalDrivePath -Name '' | Should -Be ''
    }
}

Describe 'ConvertFrom-SmartctlJson' {
    BeforeAll {
        $script:AtaJson = @'
{
  "device": { "name": "/dev/sdd", "type": "sat", "protocol": "ATA" },
  "model_name": "WDC WD140EDGZ-11B1PA0",
  "serial_number": "WD-ABC123",
  "firmware_version": "85.00A85",
  "rotation_rate": 7200,
  "smart_support": { "available": true, "enabled": true },
  "smart_status": { "passed": true },
  "temperature": { "current": 34 },
  "power_on_time": { "hours": 12345 },
  "power_cycle_count": 42,
  "ata_smart_attributes": {
    "table": [
      { "id": 5, "name": "Reallocated_Sector_Ct", "value": 100, "worst": 100, "thresh": 10,
        "when_failed": "", "raw": { "value": 0, "string": "0" } },
      { "id": 194, "name": "Temperature_Celsius", "value": 66, "worst": 55, "thresh": 0,
        "when_failed": "", "raw": { "value": 34, "string": "34 (Min/Max 20/45)" } }
    ]
  },
  "ata_smart_self_test_log": {
    "standard": {
      "table": [
        { "type": { "string": "Short offline" },
          "status": { "string": "Completed without error", "passed": true },
          "lifetime_hours": 12000 }
      ]
    }
  }
}
'@
        $script:NvmeJson = @'
{
  "device": { "name": "/dev/nvme0", "type": "nvme", "protocol": "NVMe" },
  "model_name": "Samsung SSD 990 PRO 2TB",
  "serial_number": "S6Z1NJ0T",
  "smart_status": { "passed": true },
  "nvme_smart_health_information_log": {
    "critical_warning": 0,
    "temperature": 313,
    "available_spare": 100,
    "available_spare_threshold": 10,
    "percentage_used": 3,
    "media_errors": 0,
    "num_err_log_entries": 12,
    "data_units_read": 100000,
    "data_units_written": 200000,
    "unsafe_shutdowns": 4
  },
  "power_on_time": { "hours": 5000 }
}
'@
    }

    It 'parses an ATA drive' {
        $report = ConvertFrom-SmartctlJson -Smart ($script:AtaJson | ConvertFrom-Json)
        $report.deviceId | Should -Be '\\.\PHYSICALDRIVE3'
        $report.serialNumber | Should -Be 'WD-ABC123'
        $report.model | Should -Be 'WDC WD140EDGZ-11B1PA0'
        $report.source | Should -Be 'smartctl'
        $report.overallHealthPassed | Should -BeTrue
        $report.temperatureC | Should -Be 34
        $report.powerOnHours | Should -Be 12345
        $report.rotationRate | Should -Be 7200
    }

    It 'parses the attribute table, keeping the raw string' {
        $report = ConvertFrom-SmartctlJson -Smart ($script:AtaJson | ConvertFrom-Json)
        $report.attributes.Count | Should -Be 2
        $reallocated = $report.attributes | Where-Object { $_.id -eq 5 }
        $reallocated.name | Should -Be 'Reallocated_Sector_Ct'
        $reallocated.raw | Should -Be 0
        $reallocated.threshold | Should -Be 10
        $temperature = $report.attributes | Where-Object { $_.id -eq 194 }
        $temperature.rawString | Should -Be '34 (Min/Max 20/45)'
    }

    It 'reports a passing self-test as not failed' {
        $report = ConvertFrom-SmartctlJson -Smart ($script:AtaJson | ConvertFrom-Json)
        $report.selfTest.failed | Should -BeFalse
        $report.selfTest.status | Should -Be 'Completed without error'
    }

    It 'reports a failing self-test' {
        $json = $script:AtaJson.Replace('"passed": true,`n          "lifetime_hours"', '"passed": false, "lifetime_hours"')
        $object = $script:AtaJson | ConvertFrom-Json
        $object.ata_smart_self_test_log.standard.table[0].status.passed = $false
        $object.ata_smart_self_test_log.standard.table[0].status.string = 'Completed: read failure'
        (ConvertFrom-SmartctlJson -Smart $object).selfTest.failed | Should -BeTrue
        $json | Should -Not -BeNullOrEmpty
    }

    It 'parses an NVMe drive and converts kelvin to celsius' {
        $report = ConvertFrom-SmartctlJson -Smart ($script:NvmeJson | ConvertFrom-Json)
        $report.nvme.percentageUsed | Should -Be 3
        $report.nvme.availableSpare | Should -Be 100
        $report.nvme.unsafeShutdowns | Should -Be 4
        $report.temperatureC | Should -Be 40
        $report.attributes.Count | Should -Be 0
    }

    It 'returns null for null input' {
        ConvertFrom-SmartctlJson -Smart $null | Should -BeNullOrEmpty
    }

    It 'uses the fallback device id when smartctl reports no device name' {
        $report = ConvertFrom-SmartctlJson -Smart ([pscustomobject]@{ serial_number = 'X' }) -FallbackDeviceId '\\.\PHYSICALDRIVE9'
        $report.deviceId | Should -Be '\\.\PHYSICALDRIVE9'
    }

    It 'tolerates a drive that reports almost nothing' {
        $report = ConvertFrom-SmartctlJson -Smart ('{"device":{"name":"/dev/sdb"}}' | ConvertFrom-Json)
        $report.deviceId | Should -Be '\\.\PHYSICALDRIVE1'
        $report.overallHealthPassed | Should -BeNullOrEmpty
        $report.attributes.Count | Should -Be 0
        $report.nvme | Should -BeNullOrEmpty
    }

    It 'records a failed SMART status' {
        $object = $script:AtaJson | ConvertFrom-Json
        $object.smart_status.passed = $false
        (ConvertFrom-SmartctlJson -Smart $object).overallHealthPassed | Should -BeFalse
    }
}

Describe 'ConvertFrom-StorageReliabilityCounter' {
    It 'shapes the Windows fallback counters into a report' {
        $counter = [pscustomobject]@{
            Temperature           = 38
            PowerOnHours          = 4000
            Wear                  = 12
            ReadErrorsUncorrected = 3
            WriteErrorsUncorrected = 0
        }
        $report = ConvertFrom-StorageReliabilityCounter -Counter $counter -DeviceId '\\.\PHYSICALDRIVE1' -SerialNumber 'S1' -Model 'M1'
        $report.source | Should -Be 'storage-reliability'
        $report.temperatureC | Should -Be 38
        $report.powerOnHours | Should -Be 4000
        $report.nvme.percentageUsed | Should -Be 12
        ($report.attributes | Where-Object { $_.id -eq 187 }).raw | Should -Be 3
        ($report.attributes | Where-Object { $_.id -eq 184 }).raw | Should -Be 0
    }

    It 'returns null when Windows has no counters for the disk' {
        ConvertFrom-StorageReliabilityCounter -Counter $null -DeviceId 'x' | Should -BeNullOrEmpty
    }
}

Describe 'ConvertFrom-DpcmdPoolParts' {
    BeforeAll {
        # Verbatim output from DrivePool 2.3.13.1687 on the target host.
        $script:PoolPartsOutput = @'
dpcmd - StableBit DrivePool command line interface

Version 2.3.13.1687

 + Pool ID 'd304fce8-5935-49cb-a280-e93bf43d12bd':
  - '\\?\GLOBALROOT\Device\HarddiskVolume2\PoolPart.4f0ccc7c-7f7f-40e8-ad6c-745d52d96842' [Device 0]
  - '\\?\GLOBALROOT\Device\HarddiskVolume8\PoolPart.a546b1c2-8af0-47a5-b2ee-d5eeadb98481' [Device 4]
  - '\\?\GLOBALROOT\Device\HarddiskVolume10\PoolPart.e83fad5b-1e0d-4101-b337-b308443ca478' [Device 5]
'@ -split "`r?`n"
    }

    It 'parses the real DrivePool 2.3.x listing' {
        $parts = ConvertFrom-DpcmdPoolParts -Lines $script:PoolPartsOutput
        $parts.Count | Should -Be 3
        $parts[0].partId | Should -Be 'PoolPart.4f0ccc7c-7f7f-40e8-ad6c-745d52d96842'
        $parts[0].poolId | Should -Be 'd304fce8-5935-49cb-a280-e93bf43d12bd'
        $parts[0].volumeDevice | Should -Be '\Device\HarddiskVolume2'
        $parts[0].deviceIndex | Should -Be 0
        $parts[2].volumeDevice | Should -Be '\Device\HarddiskVolume10'
        $parts[2].deviceIndex | Should -Be 5
    }

    It 'tags every part with the pool it belongs to' {
        $parts = ConvertFrom-DpcmdPoolParts -Lines $script:PoolPartsOutput
        ($parts | ForEach-Object { $_.poolId } | Select-Object -Unique).Count | Should -Be 1
    }

    It 'keeps parts of two pools apart' {
        $lines = @(
            " + Pool ID 'pool-a':",
            "  - '\\?\GLOBALROOT\Device\HarddiskVolume2\PoolPart.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' [Device 0]",
            " + Pool ID 'pool-b':",
            "  - '\\?\GLOBALROOT\Device\HarddiskVolume4\PoolPart.11111111-2222-3333-4444-555555555555' [Device 1]"
        )
        $parts = ConvertFrom-DpcmdPoolParts -Lines $lines
        $parts.Count | Should -Be 2
        $parts[0].poolId | Should -Be 'pool-a'
        $parts[1].poolId | Should -Be 'pool-b'
    }

    It 'ignores the banner and version lines' {
        (ConvertFrom-DpcmdPoolParts -Lines @('dpcmd - StableBit DrivePool command line interface', 'Version 2.3.13.1687')).Count | Should -Be 0
        (ConvertFrom-DpcmdPoolParts -Lines $null).Count | Should -Be 0
    }
}

Describe 'Array-returning functions' {
    # These functions return with the `, $array` idiom so an empty result is still an
    # array. That does not compose with an @() wrapper at the call site — @(f) then
    # nests the array one level deeper and every element access silently returns an
    # array instead of a record. Assert the contract so a future caller cannot
    # reintroduce it unnoticed.
    It 'returns records directly, not an array wrapped in another array' {
        $lines = @(" + Pool ID 'p':", "  - '\\?\GLOBALROOT\Device\HarddiskVolume8\PoolPart.aaa' [Device 4]")
        $parts = ConvertFrom-DpcmdPoolParts -Lines $lines
        $parts[0] | Should -BeOfType [System.Collections.Specialized.OrderedDictionary]
        $parts[0].partId | Should -Be 'PoolPart.aaa'
    }

    It 'still yields a countable empty array when there is nothing to report' {
        (ConvertFrom-DpcmdPoolParts -Lines @('nothing here')).Count | Should -Be 0
        (ConvertFrom-RxpccStatus -Lines @('nothing here')).Count | Should -Be 0
        (ConvertFrom-RxpccVolumeList -Lines @('nothing here')).Count | Should -Be 0
    }

    It 'lets a resolved part be updated in place' {
        $lines = @(" + Pool ID 'p':", "  - '\\?\GLOBALROOT\Device\HarddiskVolume8\PoolPart.bbb' [Device 4]")
        $parts = ConvertFrom-DpcmdPoolParts -Lines $lines
        $resolved = Resolve-PoolPartVolume -Parts $parts -Volumes @() -TestPath { param($p) $false }
        $resolved[0].missing | Should -BeTrue
    }
}

Describe 'Resolve-PoolPartVolume' {
    BeforeAll {
        $script:Volumes = @(
            [pscustomobject]@{ driveLetter = 'E'; label = 'DRIVEPOOL4'; volumeId = 'vol-e'; fileSystem = 'NTFS'
                sizeBytes = 8000; freeBytes = 2000; path = '\\?\Volume{e}\'; mountPoints = @()
                physicalDiskIds = @('\\.\PHYSICALDRIVE4') },
            [pscustomobject]@{ driveLetter = 'J'; label = 'DrivePool'; volumeId = 'vol-j'; fileSystem = 'Covefs'
                sizeBytes = 90000; freeBytes = 3000; path = '\\?\Volume{j}\'; mountPoints = @()
                physicalDiskIds = @() }
        )
    }

    It 'finds the volume holding the PoolPart folder and fills in its details' {
        $parts = @([ordered]@{
                partId = 'PoolPart.abc'; poolId = 'p'; name = ''; volumeId = ''; volumeLabel = ''
                driveLetter = $null; path = '\\?\GLOBALROOT\Device\HarddiskVolume8\PoolPart.abc'
                volumeDevice = ''; deviceIndex = 4; sizeBytes = $null; freeBytes = $null
                usedBytes = $null; physicalDiskId = $null; missing = $false; readOnly = $false
            })
        $resolved = Resolve-PoolPartVolume -Parts $parts -Volumes $script:Volumes -TestPath {
            param($path) $path -eq 'E:\PoolPart.abc'
        }
        $resolved[0].driveLetter | Should -Be 'E'
        $resolved[0].volumeLabel | Should -Be 'DRIVEPOOL4'
        $resolved[0].sizeBytes | Should -Be 8000
        $resolved[0].usedBytes | Should -Be 6000
        $resolved[0].physicalDiskId | Should -Be '\\.\PHYSICALDRIVE4'
        $resolved[0].missing | Should -BeFalse
    }

    It 'marks a part missing when no volume on this host holds it' {
        # This is exactly what a dropped pool disk looks like.
        $parts = @([ordered]@{
                partId = 'PoolPart.gone'; poolId = 'p'; name = ''; volumeId = ''; volumeLabel = ''
                driveLetter = $null; path = ''; volumeDevice = ''; deviceIndex = 9
                sizeBytes = $null; freeBytes = $null; usedBytes = $null; physicalDiskId = $null
                missing = $false; readOnly = $false
            })
        $resolved = Resolve-PoolPartVolume -Parts $parts -Volumes $script:Volumes -TestPath { param($path) $false }
        $resolved[0].missing | Should -BeTrue
        $resolved[0].driveLetter | Should -BeNullOrEmpty
    }

    It 'finds a pool disk mounted into a folder rather than given a letter' {
        # The usual arrangement once an array has more disks than there are letters.
        $volumes = @(
            [pscustomobject]@{ driveLetter = $null; label = 'DRIVEPOOL4'; volumeId = 'vol-x'
                fileSystem = 'NTFS'; sizeBytes = 8000; freeBytes = 500
                path = '\\?\Volume{aaaa}\'; mountPoints = @('C:\PoolDisks\DRIVEPOOL4\')
                physicalDiskIds = @('\\.\PHYSICALDRIVE7') }
        )
        $parts = @([ordered]@{
                partId = 'PoolPart.abc'; poolId = 'p'; name = ''; volumeId = ''; volumeLabel = ''
                driveLetter = $null; path = ''; volumeDevice = ''; deviceIndex = 0
                sizeBytes = $null; freeBytes = $null; usedBytes = $null; physicalDiskId = $null
                missing = $false; readOnly = $false
            })
        $resolved = Resolve-PoolPartVolume -Parts $parts -Volumes $volumes -TestPath {
            param($path) $path -eq 'C:\PoolDisks\DRIVEPOOL4\PoolPart.abc'
        }
        $resolved[0].missing | Should -BeFalse
        $resolved[0].volumeLabel | Should -Be 'DRIVEPOOL4'
        $resolved[0].path | Should -Be 'C:\PoolDisks\DRIVEPOOL4\PoolPart.abc'
        $resolved[0].physicalDiskId | Should -Be '\\.\PHYSICALDRIVE7'
    }

    It 'falls back to the volume GUID path when there is neither letter nor mount point' {
        $volumes = @(
            [pscustomobject]@{ driveLetter = $null; label = 'DRIVEPOOL9'; volumeId = 'vol-y'
                fileSystem = 'NTFS'; sizeBytes = 10; freeBytes = 1
                path = '\\?\Volume{bbbb}\'; mountPoints = @(); physicalDiskIds = @() }
        )
        $parts = @([ordered]@{
                partId = 'PoolPart.def'; poolId = 'p'; name = ''; volumeId = ''; volumeLabel = ''
                driveLetter = $null; path = ''; volumeDevice = ''; deviceIndex = 0
                sizeBytes = $null; freeBytes = $null; usedBytes = $null; physicalDiskId = $null
                missing = $false; readOnly = $false
            })
        $resolved = Resolve-PoolPartVolume -Parts $parts -Volumes $volumes -TestPath {
            param($path) $path -eq '\\?\Volume{bbbb}\PoolPart.def'
        }
        $resolved[0].missing | Should -BeFalse
        $resolved[0].volumeLabel | Should -Be 'DRIVEPOOL9'
    }

    It 'never looks for PoolPart folders on the pool drive itself' {
        $probed = New-Object System.Collections.Generic.List[string]
        $parts = @([ordered]@{
                partId = 'PoolPart.abc'; poolId = 'p'; name = ''; volumeId = ''; volumeLabel = ''
                driveLetter = $null; path = ''; volumeDevice = ''; deviceIndex = 0
                sizeBytes = $null; freeBytes = $null; usedBytes = $null; physicalDiskId = $null
                missing = $false; readOnly = $false
            })
        Resolve-PoolPartVolume -Parts $parts -Volumes $script:Volumes -TestPath {
            param($path) $probed.Add($path); $false
        } | Out-Null
        $probed | Should -Not -Contain 'J:\PoolPart.abc'
        $probed | Should -Contain 'E:\PoolPart.abc'
    }
}

Describe 'ConvertFrom-DpcmdDuplication' {
    BeforeAll {
        # Verbatim `dpcmd get-duplication 'J:\Tier1'` on the target host.
        $script:DuplicationOutput = @'
dpcmd - StableBit DrivePool command line interface

Version 2.3.13.1687

Found '\\?\J:\Tier1\'

  Expected number of copies: 2
  Found number of copies: 14
  Is directory: True
  Has multiple sub-duplication counts: False

  - \Device\HarddiskVolume10\PoolPart.e83fad5b-1e0d-4101-b337-b308443ca478\Tier1
  - \Device\HarddiskVolume12\PoolPart.26162f04-dc22-4f09-8197-795630a24b8e\Tier1
'@ -split "`r?`n"
    }

    It 'reads the configured duplication level' {
        ConvertFrom-DpcmdDuplication -Lines $script:DuplicationOutput | Should -Be 2
    }

    It 'reads the whole detail block' {
        $detail = ConvertFrom-DpcmdDuplicationDetail -Lines $script:DuplicationOutput
        $detail.found | Should -BeTrue
        $detail.path | Should -Be '\\?\J:\Tier1\'
        $detail.expectedCopies | Should -Be 2
        $detail.foundCopies | Should -Be 14
        $detail.isDirectory | Should -BeTrue
        $detail.hasMixedSubCounts | Should -BeFalse
    }

    It 'flags a folder whose descendants differ, so the probe knows to descend' {
        $lines = @('Found ''\\?\J:\Tier3\''', '  Expected number of copies: 1',
            '  Is directory: True', '  Has multiple sub-duplication counts: True')
        (ConvertFrom-DpcmdDuplicationDetail -Lines $lines).hasMixedSubCounts | Should -BeTrue
    }

    It 'returns null when the path was not found' {
        ConvertFrom-DpcmdDuplication -Lines @('dpcmd', 'Error: path not found') | Should -BeNullOrEmpty
        ConvertFrom-DpcmdDuplication -Lines $null | Should -BeNullOrEmpty
    }
}

Describe 'Select-ChangedDuplicationRules' {
    It 'keeps only folders that differ from what they inherit' {
        $map = @{
            ''                  = 1
            'Media'             = 2
            'Media/Movies'      = 2
            'Media/Movies/4K'   = 3
            'Backups'           = 3
        }
        $rules = Select-ChangedDuplicationRules -Map $map -PoolId '{hdd}'
        ($rules | ForEach-Object { $_.path }) | Should -Be @('', 'Backups', 'Media', 'Media/Movies/4K')
    }

    It 'tags every rule with the pool id' {
        $rules = Select-ChangedDuplicationRules -Map @{ '' = 1 } -PoolId '{hdd}'
        $rules[0].poolId | Should -Be '{hdd}'
    }

    It 'handles an empty map' {
        (Select-ChangedDuplicationRules -Map @{}).Count | Should -Be 0
    }

    It 'keeps a nested folder whose level differs even when its parent matches the root' {
        $map = @{ '' = 1; 'A' = 1; 'A/B' = 2 }
        $rules = Select-ChangedDuplicationRules -Map $map
        ($rules | ForEach-Object { $_.path }) | Should -Be @('', 'A/B')
    }
}

Describe 'Get-PoolRelativePath' {
    It 'strips the pool root' {
        Get-PoolRelativePath -Root 'P:\' -FullPath 'P:\Media\Movies' | Should -Be 'Media/Movies'
        Get-PoolRelativePath -Root 'P:' -FullPath 'P:\Media' | Should -Be 'Media'
    }

    It 'returns empty for the root itself' {
        Get-PoolRelativePath -Root 'P:\' -FullPath 'P:\' | Should -Be ''
    }

    It 'ignores case differences in the drive letter' {
        Get-PoolRelativePath -Root 'p:\' -FullPath 'P:\Media' | Should -Be 'Media'
    }
}

Describe 'PrimoCache' {
    BeforeAll {
        # Verbatim `rxpcc status` from the target host.
        $script:RxpccStatus = @'
Cache Task #1 {507EEFF9-B281-489B-914F-F402D497E55E}
----------------------------------------------------
  Status: Active
  Level-1 Cache: 262144MB
    MM: 262144MB, IM: 0MB
    R/W Ratio: Shared
    Options: -
  Level-2 Cache: 953618MB
    R/W Ratio: Shared
    Storage: {D4CEAE5C-9802-4DB5-9510-6B6CCBEF8D2F}
    Gather Interval: INSTANT
    Options: -
  Block Size: 32KB
  Strategy: Read & Write
  Defer-Write: Enabled
    Latency: 300s
    Mode: Intelligent
    Options: L1ToL2
  Prefetch: Enabled, Boot, FromL2
  Overhead: 12.48GB

Volume #8: Cache (Active)
  Strategy: Read & Write
  Level-2 Cache: Enabled
  Defer-Write: Enabled
  Prefetch: Enabled

Volume #10: Cache (Active)
  Strategy: Read & Write
  Level-2 Cache: Enabled
  Defer-Write: Enabled
  Prefetch: Enabled
'@ -split "`r?`n"

        # Verbatim `rxpcc ls` from the target host.
        $script:RxpccLs = @'
Volume List
===========

Index      Name                   FileSys  Free/Capacity         Cluster  Cache
-------------------------------------------------------------------------------
Disk0      ATA     ST20000NM002C-3X        18627.00GB
  Vol #2   DRIVEPOOL17            NTFS     288.37GB/18626.98GB   8KB
  Vol #1   Local Volume                    16MB

Disk1      ATA     SanDisk SSD PLUS        931.51GB
  Vol #3   SSD-BAY1 (F:)          NTFS     134.43GB/931.51GB     4KB

Disk4      ATA     ST8000VN004-3CP1        7452.04GB
  Vol #7   Local Volume                    16MB
  Vol #8   DRIVEPOOL4             NTFS     272.14GB/7452.02GB    4KB      1

Disk5      ATA     ST8000VN004-3CP1        7452.04GB
  Vol #10  DRIVEPOOL9             NTFS     272.29GB/7452.02GB    4KB      1
  Vol #9   Local Volume                    16MB
'@ -split "`r?`n"
    }

    Context 'status' {
        It 'parses the cache task, its levels and its settings' {
            $caches = ConvertFrom-RxpccStatus -Lines $script:RxpccStatus
            $caches.Count | Should -Be 1
            $caches[0].name | Should -Be 'Cache Task #1'
            $caches[0].status | Should -Be 'Active'
            $caches[0].strategy | Should -Be 'Read & Write'
            $caches[0].blockSize | Should -Be '32KB'
            $caches[0].deferWrite | Should -BeTrue
            $caches[0].level | Should -Be 'L1+L2'
        }

        It 'converts the level sizes to bytes and totals them' {
            $caches = ConvertFrom-RxpccStatus -Lines $script:RxpccStatus
            $caches[0].level1SizeBytes | Should -Be (262144 * 1024 * 1024)
            $caches[0].level2SizeBytes | Should -Be (953618 * 1024 * 1024)
            $caches[0].cacheSizeBytes | Should -Be ((262144 + 953618) * 1024 * 1024)
        }

        It 'reads the overhead as the used figure' {
            $caches = ConvertFrom-RxpccStatus -Lines $script:RxpccStatus
            $caches[0].usedBytes | Should -Be ([long][math]::Round(12.48 * [math]::Pow(1024, 3)))
        }

        It 'does not let a volume block overwrite the task settings' {
            # Each `Volume #N` block repeats Strategy and Defer-Write; those belong to
            # the volume, not the task, and must not clobber what the task reported.
            $caches = ConvertFrom-RxpccStatus -Lines $script:RxpccStatus
            $caches[0].blockSize | Should -Be '32KB'
            $caches[0].targetVolumes.Count | Should -Be 2
        }

        It 'returns nothing when there are no cache tasks' {
            (ConvertFrom-RxpccStatus -Lines @('No cache task found.')).Count | Should -Be 0
            (ConvertFrom-RxpccStatus -Lines $null).Count | Should -Be 0
        }
    }

    Context 'volume list' {
        It 'parses labelled volumes with their sizes' {
            $volumes = ConvertFrom-RxpccVolumeList -Lines $script:RxpccLs
            $pool17 = $volumes | Where-Object { $_.label -eq 'DRIVEPOOL17' }
            $pool17.disk | Should -Be 'Disk0'
            $pool17.index | Should -Be 2
            $pool17.fileSystem | Should -Be 'NTFS'
            $pool17.sizeBytes | Should -Be ([long][math]::Round(18626.98 * [math]::Pow(1024, 3)))
            $pool17.cacheTask | Should -BeNullOrEmpty
        }

        It 'splits a drive letter out of the label' {
            $volumes = ConvertFrom-RxpccVolumeList -Lines $script:RxpccLs
            $bay1 = $volumes | Where-Object { $_.index -eq 3 }
            $bay1.label | Should -Be 'SSD-BAY1'
            $bay1.driveLetter | Should -Be 'F'
        }

        It 'reads the trailing cache-task column' {
            $volumes = ConvertFrom-RxpccVolumeList -Lines $script:RxpccLs
            ($volumes | Where-Object { $_.label -eq 'DRIVEPOOL4' }).cacheTask | Should -Be 1
            ($volumes | Where-Object { $_.label -eq 'DRIVEPOOL9' }).cacheTask | Should -Be 1
        }

        It 'keeps volumes with no filesystem without inventing sizes' {
            $volumes = ConvertFrom-RxpccVolumeList -Lines $script:RxpccLs
            $local = $volumes | Where-Object { $_.index -eq 1 }
            $local.label | Should -Be 'Local Volume'
            $local.sizeBytes | Should -BeNullOrEmpty
        }

        It 'skips the header and rule lines' {
            $volumes = ConvertFrom-RxpccVolumeList -Lines $script:RxpccLs
            $volumes | Where-Object { $_.label -match 'Index|Volume List' } | Should -BeNullOrEmpty
        }
    }

    Context 'perf' {
        BeforeAll {
            # Verbatim `rxpcc perf -a` output from tokyo-3, including the volume that is
            # taking the write load (#14) and a block truncated mid-line, which is how it
            # arrives when the console buffer runs out.
            $script:RxpccPerf = @'
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

Volume #14:
  Total Read            : 593.67MB
  Cached Read           : 144.0KB (0.0%)
  L2Storage Read        : 0 (0.0%)
  L2Storage Write       : 0
  Total Write (Req)     : 11.27GB
  Total Write (L1/L2)   : 11.26GB / 6.96MB
  Total Write (Disk)    : 3.18GB (28.2%)
    Urgent/Normal       : 0 / 3.18GB
  Deferred Blocks       : 20604 (0.1%)
  Trimmed Blocks        : 119532
  Prefetch              : Inactive
  Unused Cache (L1)     : 121.12GB
  Unused Cache (L2)     : 74.02GB
  Stat Start Time       : 2026-08-28 12:41:16

Volume #22:
  Total Read            : 542.06MB
  Cached Read           : 2.31MB (0.4%)
  Total Write (Req)     : 31.43MB
  Total Write (Disk)    : 25.46MB (81.0%)
    Urgent/Normal       :
'@ -split "`r?`n"
        }

        It 'reads one block per cached volume, keyed the way `ls` numbers them' {
            $perf = ConvertFrom-RxpccPerf -Lines $script:RxpccPerf
            $perf.recognised | Should -BeTrue
            $perf.volumes.Count | Should -Be 4
            $perf.volumes[0].volume | Should -Be 8
            $perf.volumes[1].volume | Should -Be 10
            $perf.volumes[2].volume | Should -Be 14
        }

        # The read hit rate is the percentage beside "Cached Read": the share of read
        # bytes the cache served. There is no line called a hit rate anywhere.
        It 'takes the read hit rate from the cached read share' {
            $volume = (ConvertFrom-RxpccPerf -Lines $script:RxpccPerf).volumes[0]
            $volume.readHitRate | Should -Be 0.217
            $volume.readBytes | Should -Be 689428234
            $volume.cachedReadBytes | Should -Be 149851996
        }

        It 'reads the level-2 contribution separately from level 1' {
            $volume = (ConvertFrom-RxpccPerf -Lines $script:RxpccPerf).volumes[0]
            $volume.level2ReadRate | Should -Be 0.073
            $volume.level2WriteBytes | Should -Be 54943369134
        }

        It 'splits the L1/L2 write pair' {
            $volume = (ConvertFrom-RxpccPerf -Lines $script:RxpccPerf).volumes[0]
            $volume.writeLevel1Bytes | Should -Be 41156608
            $volume.writeLevel2Bytes | Should -Be 32117883
        }

        # "Total Write (Disk) 78.0%" is the share that still reached the disk, so it is
        # the inverse of what the cache absorbed. Reporting it as a hit rate would say
        # the cache was doing well when it was barely helping.
        It 'keeps the disk-write share the right way round' {
            $volume = (ConvertFrom-RxpccPerf -Lines $script:RxpccPerf).volumes[0]
            $volume.writeToDiskRate | Should -Be 0.78
            $volume.writeAbsorbedRate | Should -Be 0.22
        }

        It 'shows the write-heavy volume absorbing most of its writes' {
            $volume = (ConvertFrom-RxpccPerf -Lines $script:RxpccPerf).volumes[2]
            $volume.writeAbsorbedRate | Should -Be 0.718
            $volume.deferredBlocks | Should -Be 20604
            $volume.trimmedBlocks | Should -Be 119532
        }

        It 'parses prefetch progress, and its absence' {
            $volumes = (ConvertFrom-RxpccPerf -Lines $script:RxpccPerf).volumes
            $volumes[0].prefetchState | Should -Be 'Done'
            $volumes[0].prefetchLoadedBytes | Should -Be 18210661335
            $volumes[0].prefetchTotalBytes | Should -Be 20830591386
            $volumes[2].prefetchState | Should -Be 'Inactive'
            $volumes[2].prefetchLoadedBytes | Should -BeNullOrEmpty
        }

        # Every figure is cumulative since this moment, so a rate without it is meaningless.
        It 'keeps the window the statistics cover' {
            $volume = (ConvertFrom-RxpccPerf -Lines $script:RxpccPerf).volumes[0]
            $volume.statsSince | Should -Match '^2026-08-28T12:41:15'
        }

        It 'lifts unused cache to the report, since it is the same in every block' {
            $perf = ConvertFrom-RxpccPerf -Lines $script:RxpccPerf
            $perf.unusedLevel1Bytes | Should -Be 130051609723
            $perf.unusedLevel2Bytes | Should -Be 79478369812
        }

        It 'keeps a block that was cut off mid-line rather than dropping it' {
            $volume = (ConvertFrom-RxpccPerf -Lines $script:RxpccPerf).volumes[3]
            $volume.volume | Should -Be 22
            $volume.readHitRate | Should -Be 0.004
            $volume.trimmedBlocks | Should -BeNullOrEmpty
        }

        It 'reads a zero without turning it into nothing' {
            $volume = (ConvertFrom-RxpccPerf -Lines $script:RxpccPerf).volumes[1]
            $volume.level2ReadBytes | Should -Be 0
            $volume.level2ReadRate | Should -Be 0
        }

        It 'reports nothing rather than guessing when the wording is unrecognised' {
            $perf = ConvertFrom-RxpccPerf -Lines @('Some Other Statistic: 42')
            $perf.recognised | Should -BeFalse
            $perf.volumes.Count | Should -Be 0
        }

        It 'handles empty input' {
            (ConvertFrom-RxpccPerf -Lines $null).recognised | Should -BeFalse
        }
    }

    Context 'combined report' {
        It 'names each cache after the volumes it fronts' {
            $caches = ConvertFrom-RxpccStatus -Lines $script:RxpccStatus
            $volumes = ConvertFrom-RxpccVolumeList -Lines $script:RxpccLs
            $report = Join-PrimoCacheReport -Caches $caches -Volumes $volumes -Version '4.3.0'

            $report.available | Should -BeTrue
            $report.version | Should -Be '4.3.0'
            $report.caches[0].targetVolumes | Should -Contain 'DRIVEPOOL4'
            $report.caches[0].targetVolumes | Should -Contain 'DRIVEPOOL9'
        }

        # perf is per volume, status is per cache task, and only `ls` knows which volume
        # belongs to which task. Vol #8 is DRIVEPOOL4 and Vol #10 is DRIVEPOOL9, both on
        # cache task 1, so the task's rate is the two of them summed.
        It 'joins per-volume statistics onto the cache task that fronts them' {
            $caches = ConvertFrom-RxpccStatus -Lines $script:RxpccStatus
            $volumes = ConvertFrom-RxpccVolumeList -Lines $script:RxpccLs
            $perf = ConvertFrom-RxpccPerf -Lines $script:RxpccPerf
            $report = Join-PrimoCacheReport -Caches $caches -Volumes $volumes -Perf $perf

            $cache = $report.caches[0]
            $cache.volumeStats.Count | Should -Be 2
            $cache.volumeStats[0].label | Should -Be 'DRIVEPOOL4'
            $cache.volumeStats[1].label | Should -Be 'DRIVEPOOL9'
            # (142.91 + 15.92) / (657.49 + 584.55)
            $cache.readHitRate | Should -Be 0.1279
            # (54.48 + 3.62) / (69.88 + 6.84)
            $cache.writeAbsorbedRate | Should -Be 0.2427
            $cache.statsSince | Should -Match '^2026-08-28T12:41:15'
        }

        # Volume #14 is not on this cache task and its 11 GB of writes must not be
        # counted into it, or the task would look far busier than it is.
        It 'ignores perf blocks for volumes the task does not front' {
            $caches = ConvertFrom-RxpccStatus -Lines $script:RxpccStatus
            $volumes = ConvertFrom-RxpccVolumeList -Lines $script:RxpccLs
            $perf = ConvertFrom-RxpccPerf -Lines $script:RxpccPerf
            $report = Join-PrimoCacheReport -Caches $caches -Volumes $volumes -Perf $perf
            @($report.caches[0].volumeStats | ForEach-Object { $_.volume }) | Should -Be @(8, 10)
        }

        It 'carries unused cache through to the report' {
            $caches = ConvertFrom-RxpccStatus -Lines $script:RxpccStatus
            $perf = ConvertFrom-RxpccPerf -Lines $script:RxpccPerf
            $report = Join-PrimoCacheReport -Caches $caches -Volumes @() -Perf $perf
            $report.unusedLevel1Bytes | Should -Be 130051609723
        }

        It 'reports unavailable when there are no cache tasks' {
            $report = Join-PrimoCacheReport -Caches @() -Volumes @()
            $report.available | Should -BeFalse
            $report.reason | Should -Not -BeNullOrEmpty
        }
    }
}

Describe 'Performance shaping' {
    It 'converts seconds to milliseconds' {
        $sample = ConvertTo-PerformanceSample -Instance '3 E:' -ReadSeconds 0.0042 -WriteSeconds 0.0015 -QueueLength 0.4
        $sample.readLatencyMs | Should -Be 4.2
        $sample.writeLatencyMs | Should -Be 1.5
        $sample.queueLength | Should -Be 0.4
        $sample.deviceId | Should -Be '\\.\PHYSICALDRIVE3'
    }

    It 'derives busy percent from idle percent' {
        $sample = ConvertTo-PerformanceSample -Instance '0 C:' -IdlePercent 82.5
        $sample.idlePercent | Should -Be 82.5
        $sample.busyPercent | Should -Be 17.5
    }

    It 'leaves idle and busy null when the counter was unavailable' {
        $sample = ConvertTo-PerformanceSample -Instance '0 C:'
        $sample.idlePercent | Should -BeNullOrEmpty
        $sample.busyPercent | Should -BeNullOrEmpty
    }

    It 'extracts the drive index from a counter instance name' {
        ConvertTo-DeviceIdFromInstance -Instance '12 X: Y:' | Should -Be '\\.\PHYSICALDRIVE12'
        ConvertTo-DeviceIdFromInstance -Instance '_Total' | Should -Be ''
    }
}

Describe 'Helpers' {
    It 'reads dotted paths and returns null for anything missing' {
        $object = '{"a":{"b":{"c":42}}}' | ConvertFrom-Json
        Get-JsonValue $object 'a.b.c' | Should -Be 42
        Get-JsonValue $object 'a.b.missing' | Should -BeNullOrEmpty
        Get-JsonValue $object 'nope.at.all' | Should -BeNullOrEmpty
        Get-JsonValue $null 'a' | Should -BeNullOrEmpty
    }

    It 'reads dotted paths out of a hashtable too' {
        Get-JsonValue @{ a = @{ b = 7 } } 'a.b' | Should -Be 7
    }

    It 'parses nullable numbers' {
        ConvertTo-NullableDouble 12 | Should -Be 12
        ConvertTo-NullableDouble '3.5' | Should -Be 3.5
        ConvertTo-NullableDouble $null | Should -BeNullOrEmpty
        ConvertTo-NullableDouble 'not a number' | Should -BeNullOrEmpty
        ConvertTo-NullableDouble $true | Should -BeNullOrEmpty
    }

    It 'parses nullable booleans' {
        ConvertTo-NullableBool $true | Should -BeTrue
        ConvertTo-NullableBool 'false' | Should -BeFalse
        ConvertTo-NullableBool $null | Should -BeNullOrEmpty
        ConvertTo-NullableBool 'maybe' | Should -BeNullOrEmpty
    }

    It 'parses human sizes into bytes' {
        ConvertFrom-SizeString '1024' | Should -Be 1024
        ConvertFrom-SizeString '1 KB' | Should -Be 1024
        ConvertFrom-SizeString '12.7 TB' | Should -Be ([long][math]::Round(12.7 * [math]::Pow(1024, 4)))
        ConvertFrom-SizeString '1,024' | Should -Be 1024
        ConvertFrom-SizeString '' | Should -BeNullOrEmpty
        ConvertFrom-SizeString 'lots' | Should -BeNullOrEmpty
    }
}

Describe 'New-AgentReport' {
    It 'produces a report with every section present' {
        $report = New-AgentReport -Hostname 'NAS-01'
        $report.protocolVersion | Should -Be 1
        $report.hostname | Should -Be 'NAS-01'
        $report.collectedAt | Should -Match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
        $report.physicalDisks.Count | Should -Be 0
        $report.smart.Count | Should -Be 0
        $report.errors.Count | Should -Be 0
        $report.primoCache | Should -BeNullOrEmpty
    }

    It 'serialises to JSON the server can accept' {
        $report = New-AgentReport -Hostname 'NAS-01' -Errors @(New-CollectorError -Collector 'primocache' -Message 'no CLI')
        $json = $report | ConvertTo-Json -Depth 10
        $round = $json | ConvertFrom-Json
        $round.hostname | Should -Be 'NAS-01'
        $round.errors[0].collector | Should -Be 'primocache'
    }

    It 'falls back to a placeholder hostname' {
        (New-AgentReport -Hostname '').hostname | Should -Be 'unknown-host'
    }
}
