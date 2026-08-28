<#
.SYNOPSIS
    Collects host data for SakuraDrive and posts it to the server.

.DESCRIPTION
    Run once by a scheduled task (see Install-SakuraDriveAgent.ps1), or with -Loop to
    keep running in the foreground. Every collector is optional and independent: if
    smartctl is missing, DrivePool is not installed, or PrimoCache exposes nothing, the
    agent reports what it could gather and records why the rest is absent, so the gap
    shows up in the web interface instead of looking like healthy silence.

.PARAMETER ConfigPath
    Path to agent.config.json. Defaults to the file beside this script.

.PARAMETER Once
    Collect and post a single report, then exit. This is the default.

.PARAMETER Loop
    Keep collecting every IntervalSeconds until stopped.

.PARAMETER DryRun
    Collect and print the report as JSON without posting it. Useful for checking what
    the agent can see before wiring it up to the server.

.EXAMPLE
    .\SakuraDriveAgent.ps1 -DryRun | Out-File report.json
#>
[CmdletBinding()]
param(
    [string] $ConfigPath,
    [switch] $Once,
    [switch] $Loop,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$moduleFile = Join-Path $PSScriptRoot 'SakuraDrive.Agent.psm1'
Import-Module $moduleFile -Force

if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot 'agent.config.json' }

function Write-AgentLog {
    param([string] $Message, [string] $Level = 'INFO', $Config = $null)

    $line = "$((Get-Date).ToString('s')) [$Level] $Message"
    Write-Host $line
    if ($null -ne $Config -and $Config.LogPath) {
        try { Add-Content -Path $Config.LogPath -Value $line -Encoding utf8 } catch { }
    }
}

function Read-AgentConfig {
    param([string] $Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Configuration file not found: $Path. Copy agent.config.example.json to agent.config.json and fill in the server URL and token."
    }
    $raw = Get-Content -LiteralPath $Path -Raw
    Merge-AgentConfig -UserConfig ($raw | ConvertFrom-Json)
}

#region Collectors ------------------------------------------------------------

function Get-PhysicalDiskInventory {
    param([System.Collections.Generic.List[object]] $Errors)

    $disks = New-Object System.Collections.Generic.List[object]
    try {
        foreach ($disk in Get-PhysicalDisk -ErrorAction Stop) {
            # Get-Disk carries the \\.\PHYSICALDRIVEn path; Get-PhysicalDisk does not.
            $deviceId = "\\.\PHYSICALDRIVE$($disk.DeviceId)"
            $disks.Add([ordered]@{
                    deviceId             = $deviceId
                    friendlyName         = [string]$disk.FriendlyName
                    model                = [string]$disk.Model
                    serialNumber         = ([string]$disk.SerialNumber).Trim()
                    firmwareVersion      = [string]$disk.FirmwareVersion
                    sizeBytes            = [double]$disk.Size
                    mediaType            = [string]$disk.MediaType
                    busType              = [string]$disk.BusType
                    healthStatus         = [string]$disk.HealthStatus
                    operationalStatus    = [string]$disk.OperationalStatus
                    physicalLocation     = [string]$disk.PhysicalLocation
                    adapterSerialNumber  = [string]$disk.AdapterSerialNumber
                    temperatureC         = $null
                })
        }
    }
    catch {
        $Errors.Add((New-CollectorError -Collector 'physical-disks' -Message $_.Exception.Message))
    }
    , $disks.ToArray()
}

function Get-VolumeInventory {
    param([System.Collections.Generic.List[object]] $Errors)

    $volumes = New-Object System.Collections.Generic.List[object]
    try {
        # Map each volume to the physical disks behind it via partition -> disk.
        $partitionMap = @{}
        try {
            foreach ($partition in Get-Partition -ErrorAction Stop) {
                if (-not $partition.AccessPaths) { continue }
                foreach ($accessPath in $partition.AccessPaths) {
                    $partitionMap[$accessPath] = "\\.\PHYSICALDRIVE$($partition.DiskNumber)"
                }
            }
        }
        catch {
            $Errors.Add((New-CollectorError -Collector 'partitions' -Message $_.Exception.Message))
        }

        foreach ($volume in Get-Volume -ErrorAction Stop) {
            if (-not $volume.Path) { continue }

            $diskIds = New-Object System.Collections.Generic.List[string]
            if ($partitionMap.ContainsKey($volume.Path)) { $diskIds.Add($partitionMap[$volume.Path]) }
            if ($volume.DriveLetter) {
                $letterPath = "$($volume.DriveLetter):\"
                if ($partitionMap.ContainsKey($letterPath)) { $diskIds.Add($partitionMap[$letterPath]) }
            }

            $volumes.Add([ordered]@{
                    volumeId          = [string]$volume.Path
                    label             = [string]$volume.FileSystemLabel
                    driveLetter       = if ($volume.DriveLetter) { [string]$volume.DriveLetter } else { $null }
                    path              = if ($volume.DriveLetter) { "$($volume.DriveLetter):\" } else { [string]$volume.Path }
                    fileSystem        = [string]$volume.FileSystemType
                    fileSystemLabel   = [string]$volume.FileSystemLabel
                    sizeBytes         = [double]$volume.Size
                    freeBytes         = [double]$volume.SizeRemaining
                    healthStatus      = [string]$volume.HealthStatus
                    operationalStatus = [string]$volume.OperationalStatus
                    dirty             = Get-VolumeDirtyBit -DriveLetter $volume.DriveLetter
                    physicalDiskIds   = @($diskIds | Select-Object -Unique)
                })
        }
    }
    catch {
        $Errors.Add((New-CollectorError -Collector 'volumes' -Message $_.Exception.Message))
    }
    , $volumes.ToArray()
}

function Get-VolumeDirtyBit {
    <#
    .SYNOPSIS
        Is the NTFS dirty bit set (chkdsk pending)?
    #>
    param($DriveLetter)

    if (-not $DriveLetter) { return $null }
    try {
        $output = & fsutil.exe dirty query "$($DriveLetter):" 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { return $null }
        # "Volume - C: is NOT Dirty" / "... is Dirty".
        if ($output -match 'is\s+NOT\s+Dirty') { return $false }
        if ($output -match 'is\s+Dirty') { return $true }
        return $null
    }
    catch {
        return $null
    }
}

function Resolve-SmartctlPath {
    param($Config)

    if ($Config.SmartctlPath -and (Test-Path -LiteralPath $Config.SmartctlPath)) {
        return $Config.SmartctlPath
    }
    $candidates = @(
        'C:\Program Files\smartmontools\bin\smartctl.exe'
        'C:\Program Files (x86)\smartmontools\bin\smartctl.exe'
        'C:\Program Files\smartmontools for Windows\bin\smartctl.exe'
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $command = Get-Command 'smartctl.exe' -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $null
}

function Get-SmartInventory {
    param($Config, [array] $PhysicalDisks, [System.Collections.Generic.List[object]] $Errors)

    $reports = New-Object System.Collections.Generic.List[object]
    if (-not $Config.CollectSmart) { return , $reports.ToArray() }

    $smartctl = Resolve-SmartctlPath -Config $Config
    if ($smartctl) {
        try {
            $scan = & $smartctl --scan-open --json 2>$null | Out-String | ConvertFrom-Json
            $devices = @(Get-JsonValue $scan 'devices')
            if ($devices.Count -eq 0) {
                $Errors.Add((New-CollectorError -Collector 'smartctl' -Message 'smartctl found no devices. On a RAID or USB controller a device type may need to be given explicitly.'))
            }
            foreach ($device in $devices) {
                $name = [string](Get-JsonValue $device 'name')
                $type = [string](Get-JsonValue $device 'type')
                try {
                    $arguments = @('--json', '-a', $name)
                    if ($type) { $arguments = @('--json', '-a', '-d', $type, $name) }
                    $json = & $smartctl @arguments 2>$null | Out-String
                    if (-not $json.Trim()) { continue }
                    $parsed = ConvertFrom-SmartctlJson -Smart ($json | ConvertFrom-Json)
                    if ($parsed) { $reports.Add($parsed) }
                }
                catch {
                    $Errors.Add((New-CollectorError -Collector 'smartctl' -Message "Failed to read $name" -Detail $_.Exception.Message))
                }
            }
        }
        catch {
            $Errors.Add((New-CollectorError -Collector 'smartctl' -Message $_.Exception.Message))
        }
    }
    else {
        $Errors.Add((New-CollectorError -Collector 'smartctl' -Message 'smartctl was not found. Install smartmontools for full SMART attributes; falling back to the Windows storage reliability counters.'))
    }

    # Fill in any disk smartctl did not cover using Windows' own counters.
    $covered = @{}
    foreach ($report in $reports) {
        $covered[(Get-DeviceKey -SerialNumber $report.serialNumber -DeviceId $report.deviceId)] = $true
    }

    foreach ($disk in $PhysicalDisks) {
        $key = Get-DeviceKey -SerialNumber $disk.serialNumber -DeviceId $disk.deviceId
        if ($covered.ContainsKey($key)) { continue }
        try {
            $number = if ($disk.deviceId -match '(\d+)$') { [int]$Matches[1] } else { $null }
            if ($null -eq $number) { continue }
            $counter = Get-PhysicalDisk -DeviceNumber $number -ErrorAction Stop |
                Get-StorageReliabilityCounter -ErrorAction Stop
            $fallback = ConvertFrom-StorageReliabilityCounter -Counter $counter -DeviceId $disk.deviceId `
                -SerialNumber $disk.serialNumber -Model $disk.model
            if ($fallback) { $reports.Add($fallback) }
        }
        catch {
            $Errors.Add((New-CollectorError -Collector 'storage-reliability' -Message "No reliability counters for $($disk.deviceId)" -Detail $_.Exception.Message))
        }
    }

    , $reports.ToArray()
}

function Resolve-DpcmdPath {
    param($Config)

    if ($Config.DpcmdPath -and (Test-Path -LiteralPath $Config.DpcmdPath)) { return $Config.DpcmdPath }
    $candidates = @(
        'C:\Program Files\StableBit\DrivePool\dpcmd.exe'
        'C:\Program Files (x86)\StableBit\DrivePool\dpcmd.exe'
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $command = Get-Command 'dpcmd.exe' -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $null
}

function Get-PoolInventory {
    <#
    .SYNOPSIS
        Discover DrivePool pools, their parts and their duplication settings.
    .DESCRIPTION
        Pool drives are found by their filesystem type (Covefs). Pool parts come from
        dpcmd when it is available and, failing that, from the PoolPart.* folders that
        DrivePool creates at the root of each member disk — which is enough to see the
        parts even without the command line tool.
    #>
    param($Config, [array] $Volumes, [System.Collections.Generic.List[object]] $Errors)

    $result = [ordered]@{ pools = @(); duplication = @() }
    if (-not $Config.CollectDrivePool) { return $result }

    $poolVolumes = @($Volumes | Where-Object { $_.fileSystem -match 'covefs' -and $_.driveLetter })
    if ($poolVolumes.Count -eq 0) {
        $Errors.Add((New-CollectorError -Collector 'drivepool' -Message 'No DrivePool volumes found. Pool drives are identified by the Covefs filesystem.'))
        return $result
    }

    $dpcmd = Resolve-DpcmdPath -Config $Config
    $pools = New-Object System.Collections.Generic.List[object]
    $duplication = New-Object System.Collections.Generic.List[object]

    foreach ($poolVolume in $poolVolumes) {
        $root = "$($poolVolume.driveLetter):\"
        $poolId = if ($poolVolume.volumeId) { $poolVolume.volumeId } else { $root }
        $parts = @()

        if ($dpcmd) {
            try {
                $lines = & $dpcmd list-poolparts $root 2>&1 | ForEach-Object { [string]$_ }
                $parts = ConvertFrom-DpcmdPoolParts -Lines $lines
            }
            catch {
                $Errors.Add((New-CollectorError -Collector 'dpcmd' -Message "list-poolparts failed for $root" -Detail $_.Exception.Message))
            }
        }

        if ($parts.Count -eq 0) {
            $parts = Find-PoolPartFolders -Volumes $Volumes -Errors $Errors
        }

        # Attach the physical disk behind each part so the server can join a failing
        # SMART report to the pool it affects.
        foreach ($part in $parts) {
            $match = $Volumes | Where-Object { $_.driveLetter -eq $part.driveLetter } | Select-Object -First 1
            if ($match) {
                $part.volumeId = $match.volumeId
                if (-not $part.volumeLabel) { $part.volumeLabel = $match.label }
                if ($null -eq $part.sizeBytes) { $part.sizeBytes = $match.sizeBytes }
                if ($null -eq $part.freeBytes) { $part.freeBytes = $match.freeBytes }
                if ($match.physicalDiskIds -and $match.physicalDiskIds.Count -gt 0) {
                    $part.physicalDiskId = $match.physicalDiskIds[0]
                }
            }
        }

        $pools.Add([ordered]@{
                poolId             = $poolId
                name               = if ($poolVolume.label) { $poolVolume.label } else { "Pool $($poolVolume.driveLetter):" }
                driveLetter        = $poolVolume.driveLetter
                sizeBytes          = $poolVolume.sizeBytes
                freeBytes          = $poolVolume.freeBytes
                duplicatedBytes    = $null
                unduplicatedBytes  = $null
                parts              = @($parts)
            })

        if ($dpcmd -and [int]$Config.DuplicationDepth -ge 0) {
            $duplication.AddRange((Get-DuplicationRules -Dpcmd $dpcmd -Root $root -PoolId $poolId `
                        -Depth ([int]$Config.DuplicationDepth) -Errors $Errors))
        }
    }

    $result.pools = @($pools.ToArray())
    $result.duplication = @($duplication.ToArray())
    $result
}

function Find-PoolPartFolders {
    <#
    .SYNOPSIS
        Locate pool parts without dpcmd, by the PoolPart.* folder DrivePool creates.
    #>
    param([array] $Volumes, [System.Collections.Generic.List[object]] $Errors)

    $parts = New-Object System.Collections.Generic.List[object]
    foreach ($volume in $Volumes) {
        if (-not $volume.driveLetter) { continue }
        if ($volume.fileSystem -match 'covefs') { continue }
        try {
            $folders = Get-ChildItem -LiteralPath "$($volume.driveLetter):\" -Directory -Force -ErrorAction Stop |
                Where-Object { $_.Name -match '^PoolPart\.' }
            foreach ($folder in $folders) {
                $parts.Add([ordered]@{
                        partId         = $folder.Name
                        name           = $volume.label
                        volumeId       = $volume.volumeId
                        volumeLabel    = $volume.label
                        driveLetter    = $volume.driveLetter
                        path           = $folder.FullName
                        sizeBytes      = $volume.sizeBytes
                        freeBytes      = $volume.freeBytes
                        usedBytes      = $null
                        physicalDiskId = if ($volume.physicalDiskIds.Count -gt 0) { $volume.physicalDiskIds[0] } else { $null }
                        missing        = $false
                        readOnly       = $false
                    })
            }
        }
        catch {
            $Errors.Add((New-CollectorError -Collector 'poolparts' -Message "Could not list $($volume.driveLetter):\" -Detail $_.Exception.Message))
        }
    }
    , $parts.ToArray()
}

function Get-DuplicationRules {
    <#
    .SYNOPSIS
        Probe duplication levels down to `Depth` folders below the pool root.
    .DESCRIPTION
        DrivePool inherits duplication downward, so only folders whose level differs
        from what they inherit are reported. Probing is breadth-first and bounded, so
        the cost stays proportional to the top few levels of the tree rather than to
        the number of files.
    #>
    param(
        [string] $Dpcmd,
        [string] $Root,
        [string] $PoolId,
        [int] $Depth,
        [System.Collections.Generic.List[object]] $Errors
    )

    $map = @{}
    $queue = New-Object System.Collections.Generic.Queue[object]
    $queue.Enqueue(@{ Path = $Root.TrimEnd('\'); Level = 0 })

    while ($queue.Count -gt 0) {
        $item = $queue.Dequeue()
        $relative = Get-PoolRelativePath -Root $Root -FullPath $item.Path

        try {
            $lines = & $Dpcmd get-duplication $item.Path 2>&1 | ForEach-Object { [string]$_ }
            $level = ConvertFrom-DpcmdDuplication -Lines $lines
            if ($null -ne $level) { $map[$relative] = $level }
        }
        catch {
            $Errors.Add((New-CollectorError -Collector 'dpcmd' -Message "get-duplication failed for $($item.Path)" -Detail $_.Exception.Message))
        }

        if ($item.Level -ge $Depth) { continue }
        try {
            foreach ($child in Get-ChildItem -LiteralPath $item.Path -Directory -Force -ErrorAction Stop) {
                if ($child.Name -match '^\$RECYCLE\.BIN$|^System Volume Information$') { continue }
                $queue.Enqueue(@{ Path = $child.FullName; Level = $item.Level + 1 })
            }
        }
        catch {
            # An unreadable folder is not worth failing the whole probe over.
        }
    }

    Select-ChangedDuplicationRules -Map $map -PoolId $PoolId
}

function Get-PerformanceInventory {
    param($Config, [System.Collections.Generic.List[object]] $Errors)

    $samples = New-Object System.Collections.Generic.List[object]
    if (-not $Config.CollectPerformance) { return , $samples.ToArray() }

    $counters = @(
        '\PhysicalDisk(*)\Avg. Disk sec/Read'
        '\PhysicalDisk(*)\Avg. Disk sec/Write'
        '\PhysicalDisk(*)\Current Disk Queue Length'
        '\PhysicalDisk(*)\Disk Read Bytes/sec'
        '\PhysicalDisk(*)\Disk Write Bytes/sec'
        '\PhysicalDisk(*)\% Idle Time'
    )

    try {
        $seconds = [Math]::Max(1, [int]$Config.PerformanceSamples)
        $result = Get-Counter -Counter $counters -SampleInterval 1 -MaxSamples $seconds -ErrorAction Stop

        # Average each counter across the samples so a single spike does not dominate.
        $byInstance = @{}
        foreach ($set in $result) {
            foreach ($sample in $set.CounterSamples) {
                $instance = [string]$sample.InstanceName
                if ($instance -eq '_total') { continue }
                if (-not $byInstance.ContainsKey($instance)) { $byInstance[$instance] = @{} }
                $path = ([string]$sample.Path -split '\\')[-1]
                if (-not $byInstance[$instance].ContainsKey($path)) { $byInstance[$instance][$path] = @() }
                $byInstance[$instance][$path] += [double]$sample.CookedValue
            }
        }

        foreach ($instance in $byInstance.Keys) {
            $metrics = $byInstance[$instance]
            $average = {
                param($name)
                if ($metrics.ContainsKey($name) -and $metrics[$name].Count -gt 0) {
                    ($metrics[$name] | Measure-Object -Average).Average
                }
                else { 0 }
            }
            $samples.Add((ConvertTo-PerformanceSample -Instance $instance `
                        -ReadSeconds (& $average 'avg. disk sec/read') `
                        -WriteSeconds (& $average 'avg. disk sec/write') `
                        -QueueLength (& $average 'current disk queue length') `
                        -ReadBytesPerSec (& $average 'disk read bytes/sec') `
                        -WriteBytesPerSec (& $average 'disk write bytes/sec') `
                        -IdlePercent (& $average '% idle time') `
                        -SampleSeconds $seconds))
        }
    }
    catch {
        $Errors.Add((New-CollectorError -Collector 'performance' -Message $_.Exception.Message))
    }

    , $samples.ToArray()
}

function Get-PrimoCacheInventory {
    <#
    .SYNOPSIS
        Best-effort PrimoCache statistics.
    .DESCRIPTION
        RomexSoftware does not publish a command line interface or performance counters
        for PrimoCache, so there is no supported way to read its statistics
        programmatically. The agent looks for a CLI next to the installed product and
        reports clearly when it cannot find one, rather than pretending the cache is
        absent.
    #>
    param($Config, [System.Collections.Generic.List[object]] $Errors)

    if (-not $Config.CollectPrimoCache) { return $null }

    $installRoots = @(
        'C:\Program Files\Romex Software\PrimoCache'
        'C:\Program Files (x86)\Romex Software\PrimoCache'
    )
    $installed = $installRoots | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

    if (-not $installed) {
        return [ordered]@{
            available = $false
            version   = $null
            reason    = 'PrimoCache does not appear to be installed on this host.'
            caches    = @()
        }
    }

    foreach ($candidate in @('PrimoCache.exe', 'pcache.exe', 'PrimoCacheCli.exe')) {
        $cli = Join-Path $installed $candidate
        if (-not (Test-Path -LiteralPath $cli)) { continue }
        try {
            $output = & $cli --status 2>&1 | Out-String
            if ($output -match '^\s*\{') {
                $parsed = $output | ConvertFrom-Json
                return [ordered]@{
                    available = $true
                    version   = [string](Get-JsonValue $parsed 'version')
                    reason    = $null
                    caches    = @(Get-JsonValue $parsed 'caches')
                }
            }
        }
        catch {
            $Errors.Add((New-CollectorError -Collector 'primocache' -Message "Could not query $candidate" -Detail $_.Exception.Message))
        }
    }

    [ordered]@{
        available = $false
        version   = $null
        reason    = "PrimoCache is installed at $installed but exposes no command line interface this agent can read. Its statistics are only available in its own interface."
        caches    = @()
    }
}

#endregion

function Invoke-AgentCycle {
    param($Config)

    $errors = New-Object System.Collections.Generic.List[object]

    $physicalDisks = Get-PhysicalDiskInventory -Errors $errors
    $volumes = Get-VolumeInventory -Errors $errors
    $smart = Get-SmartInventory -Config $Config -PhysicalDisks $physicalDisks -Errors $errors
    $poolData = Get-PoolInventory -Config $Config -Volumes $volumes -Errors $errors
    $performance = Get-PerformanceInventory -Config $Config -Errors $errors
    $primoCache = Get-PrimoCacheInventory -Config $Config -Errors $errors

    New-AgentReport -Hostname $env:COMPUTERNAME `
        -IntervalSeconds ([int]$Config.IntervalSeconds) `
        -PhysicalDisks $physicalDisks `
        -Volumes $volumes `
        -Smart $smart `
        -Pools $poolData.pools `
        -Duplication $poolData.duplication `
        -Performance $performance `
        -PrimoCache $primoCache `
        -Errors $errors.ToArray()
}

function Send-AgentReport {
    param($Config, $Report)

    $uri = "$(([string]$Config.ServerUrl).TrimEnd('/'))/api/agent/report"
    $body = $Report | ConvertTo-Json -Depth 12 -Compress
    $parameters = @{
        Uri         = $uri
        Method      = 'Post'
        Body        = $body
        ContentType = 'application/json'
        Headers     = @{ Authorization = "Bearer $($Config.Token)" }
        TimeoutSec  = [int]$Config.TimeoutSeconds
    }
    if ($Config.SkipCertificateCheck) { $parameters['SkipCertificateCheck'] = $true }
    Invoke-RestMethod @parameters
}

# ---------------------------------------------------------------------------

$config = Read-AgentConfig -Path $ConfigPath

if (-not $DryRun) {
    $problems = Test-AgentConfig -Config $config
    if ($problems.Count -gt 0) {
        foreach ($problem in $problems) { Write-AgentLog -Message $problem -Level 'ERROR' -Config $config }
        exit 1
    }
}

do {
    try {
        $report = Invoke-AgentCycle -Config $config

        if ($DryRun) {
            $report | ConvertTo-Json -Depth 12
        }
        else {
            $response = Send-AgentReport -Config $config -Report $report
            $summary = "posted: $($report.physicalDisks.Count) disks, $($report.smart.Count) SMART reports, $($report.pools.Count) pools"
            if ($response.alertsRaised -gt 0) { $summary += ", $($response.alertsRaised) new alerts" }
            Write-AgentLog -Message $summary -Config $config
            foreach ($warning in @($response.warnings)) {
                Write-AgentLog -Message $warning -Level 'WARN' -Config $config
            }
        }
    }
    catch {
        Write-AgentLog -Message "Report failed: $($_.Exception.Message)" -Level 'ERROR' -Config $config
        if (-not $Loop) { exit 2 }
    }

    if ($Loop) { Start-Sleep -Seconds ([int]$config.IntervalSeconds) }
} while ($Loop)
