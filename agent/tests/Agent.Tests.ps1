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
    It 'parses a pool part block' {
        $lines = @(
            'dpcmd - StableBit DrivePool command line interface',
            'Version 2.3.8.1600',
            '',
            'Listing pool parts...',
            '  Pool part: E:\PoolPart.6a41b3c0-1f2e-4d5a-9b8c-0d1e2f3a4b5c',
            '    Name: DRIVEPOOL27',
            '    Total: 12.7 TB',
            '    Free: 3.6 TB',
            '  Pool part: F:\PoolPart.7b52c4d1-2e3f-4a5b-8c9d-1e2f3a4b5c6d',
            '    Name: DRIVEPOOL28',
            '    Total: 12.7 TB',
            '    Free: 900 GB'
        )
        $parts = ConvertFrom-DpcmdPoolParts -Lines $lines
        $parts.Count | Should -Be 2
        $parts[0].partId | Should -Be 'PoolPart.6a41b3c0-1f2e-4d5a-9b8c-0d1e2f3a4b5c'
        $parts[0].driveLetter | Should -Be 'E'
        $parts[0].name | Should -Be 'DRIVEPOOL27'
        $parts[0].volumeLabel | Should -Be 'DRIVEPOOL27'
        $parts[0].sizeBytes | Should -Be ([long][math]::Round(12.7 * [math]::Pow(1024, 4)))
        $parts[1].driveLetter | Should -Be 'F'
    }

    It 'marks a missing pool part' {
        $lines = @(
            '  Pool part: G:\PoolPart.8c63d5e2-3f40-4b6c-9d0e-2f3a4b5c6d7e',
            '    Name: DRIVEPOOL29',
            '    Status: missing'
        )
        (ConvertFrom-DpcmdPoolParts -Lines $lines)[0].missing | Should -BeTrue
    }

    It 'marks a read-only pool part' {
        $lines = @('  Pool part: H:\PoolPart.9d74e6f3-4051-4c7d-8e1f-3a4b5c6d7e8f', '    Read-only: yes')
        (ConvertFrom-DpcmdPoolParts -Lines $lines)[0].readOnly | Should -BeTrue
    }

    It 'returns nothing for output containing no pool parts' {
        (ConvertFrom-DpcmdPoolParts -Lines @('dpcmd', 'No pools found.')).Count | Should -Be 0
        (ConvertFrom-DpcmdPoolParts -Lines $null).Count | Should -Be 0
    }

    It 'ignores blank lines and a trailing banner' {
        $lines = @('', '  Pool part: E:\PoolPart.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '', 'Done.')
        (ConvertFrom-DpcmdPoolParts -Lines $lines).Count | Should -Be 1
    }
}

Describe 'ConvertFrom-DpcmdDuplication' {
    It 'reads an explicit duplication count' {
        ConvertFrom-DpcmdDuplication -Lines @('Duplication count: 3') | Should -Be 3
        ConvertFrom-DpcmdDuplication -Lines @('File duplication level = 2') | Should -Be 2
    }

    It 'reads the "2x" form' {
        ConvertFrom-DpcmdDuplication -Lines @('dpcmd', 'P:\Media is 2x') | Should -Be 2
    }

    It 'returns null when there is no duplication information' {
        ConvertFrom-DpcmdDuplication -Lines @('Error: path not found') | Should -BeNullOrEmpty
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
