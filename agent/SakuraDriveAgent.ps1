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
                    # A disk mounted into a folder rather than given a letter — the
                    # usual arrangement once an array outgrows 26 letters.
                    mountPoints       = @(Get-VolumeMountPoints -Volume $volume)
                })
        }
    }
    catch {
        $Errors.Add((New-CollectorError -Collector 'volumes' -Message $_.Exception.Message))
    }
    , $volumes.ToArray()
}

function Get-VolumeMountPoints {
    <#
    .SYNOPSIS
        Folder mount points for a volume, e.g. C:\PoolDisks\DRIVEPOOL4.
    .DESCRIPTION
        A pool with more disks than there are drive letters is normally mounted into
        empty folders instead. Those paths are how the agent finds the PoolPart folder
        and how the operator bind-mounts the disk into the container, so they are worth
        reporting even though Get-Volume does not surface them directly.
    #>
    param($Volume)

    try {
        $partition = Get-Partition -Volume $Volume -ErrorAction Stop
        return @(
            $partition.AccessPaths |
                Where-Object { $_ -and $_ -notmatch '^\\\\\?\\Volume\{' -and $_ -notmatch '^[A-Za-z]:\\$' }
        )
    }
    catch {
        return @()
    }
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
        Pool drives are found by their filesystem type (Covefs). `dpcmd list-poolparts`
        then gives the real pool GUID and the parts belonging to it — but identifies
        those parts only by NT device path, so each is matched back to a drive letter by
        finding which volume holds its PoolPart folder.

        Without dpcmd, parts are still discovered from the PoolPart folders themselves;
        the pool they belong to then has to come from the UI, which is why the pool id
        is a field the operator can set.
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
    if (-not $dpcmd) {
        $Errors.Add((New-CollectorError -Collector 'dpcmd' -Message 'dpcmd.exe not found. Pool parts will be discovered from PoolPart folders, but pool membership and duplication settings need to be set in the web interface.'))
    }

    $pools = New-Object System.Collections.Generic.List[object]
    $duplication = New-Object System.Collections.Generic.List[object]

    foreach ($poolVolume in $poolVolumes) {
        $root = "$($poolVolume.driveLetter):\"
        $poolId = ''
        $parts = @()

        if ($dpcmd) {
            try {
                $lines = & $dpcmd list-poolparts $root 2>&1 | ForEach-Object { [string]$_ }
                $parts = ConvertFrom-DpcmdPoolParts -Lines $lines
                if ($parts.Count -gt 0 -and $parts[0].poolId) { $poolId = $parts[0].poolId }
                $parts = Resolve-PoolPartVolume -Parts $parts -Volumes $Volumes -TestPath {
                        param($path) Test-Path -LiteralPath $path -PathType Container
                    }
            }
            catch {
                $Errors.Add((New-CollectorError -Collector 'dpcmd' -Message "list-poolparts failed for $root" -Detail $_.Exception.Message))
            }
        }

        if (-not $poolId) { $poolId = if ($poolVolume.volumeId) { $poolVolume.volumeId } else { $root } }

        if ($parts.Count -eq 0) {
            $parts = Find-PoolPartFolders -Volumes $Volumes -Errors $Errors
            foreach ($part in $parts) { $part.poolId = $poolId }
        }

        $missing = @($parts | Where-Object { $_.missing })
        if ($missing.Count -gt 0) {
            $Errors.Add((New-CollectorError -Collector 'drivepool' -Message "$($missing.Count) pool part(s) listed by DrivePool are not present on this host"))
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
        if ($volume.fileSystem -match 'covefs') { continue }
        # Prefer a letter, then a folder mount point, then the volume GUID path: a pool
        # disk on a large array often has no letter at all.
        $root = if ($volume.driveLetter) { "$($volume.driveLetter):\" }
        elseif (@($volume.mountPoints).Count -gt 0) { @($volume.mountPoints)[0] }
        elseif ($volume.path) { $volume.path }
        else { $null }
        if (-not $root) { continue }
        try {
            $folders = Get-ChildItem -LiteralPath $root -Directory -Force -ErrorAction Stop |
                Where-Object { $_.Name -match '^PoolPart\.' }
            foreach ($folder in $folders) {
                $parts.Add([ordered]@{
                        partId         = $folder.Name
                        poolId         = ''
                        name           = $volume.label
                        volumeId       = $volume.volumeId
                        volumeLabel    = $volume.label
                        driveLetter    = $volume.driveLetter
                        path           = $folder.FullName
                        volumeDevice   = ''
                        deviceIndex    = $null
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
            $Errors.Add((New-CollectorError -Collector 'poolparts' -Message "Could not list $root" -Detail $_.Exception.Message))
        }
    }
    , $parts.ToArray()
}

function Get-DuplicationRules {
    <#
    .SYNOPSIS
        Probe duplication levels below the pool root, pruning wherever DrivePool says
        the whole subtree agrees.
    .DESCRIPTION
        `dpcmd get-duplication` reports `Has multiple sub-duplication counts`. When that
        is False, every file below the folder shares one level and there is nothing to
        learn by descending — so the walk stops there. On a pool whose duplication is
        set per tier, that turns a full tree walk into a handful of calls.
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
        $descend = $true

        try {
            $lines = & $Dpcmd get-duplication $item.Path 2>&1 | ForEach-Object { [string]$_ }
            $detail = ConvertFrom-DpcmdDuplicationDetail -Lines $lines
            if ($null -ne $detail.expectedCopies) { $map[$relative] = $detail.expectedCopies }
            # False means the subtree is uniform: nothing below differs, so stop here.
            if ($detail.hasMixedSubCounts -eq $false) { $descend = $false }
        }
        catch {
            $Errors.Add((New-CollectorError -Collector 'dpcmd' -Message "get-duplication failed for $($item.Path)" -Detail $_.Exception.Message))
        }

        if (-not $descend -or $item.Level -ge $Depth) { continue }
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

function Resolve-RxpccPath {
    param($Config)

    if ($Config.RxpccPath -and (Test-Path -LiteralPath $Config.RxpccPath)) { return $Config.RxpccPath }
    $candidates = @(
        'C:\Program Files\PrimoCache\rxpcc.exe'
        'C:\Program Files (x86)\PrimoCache\rxpcc.exe'
        'C:\Program Files\Romex Software\PrimoCache\rxpcc.exe'
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $command = Get-Command 'rxpcc.exe' -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $null
}

function Get-PrimoCacheInventory {
    <#
    .SYNOPSIS
        PrimoCache statistics via its command line tool, rxpcc.
    .DESCRIPTION
        rxpcc refuses to run while the PrimoCache GUI is open — it exits with a
        "Multiple Instances" error. That is a normal, recoverable condition, not a
        fault, so it is reported as such rather than as a broken collector: the
        interface says the GUI is open instead of showing an empty panel.

        Requires administrative rights, which the agent has because the scheduled task
        runs as SYSTEM.
    #>
    param($Config, [System.Collections.Generic.List[object]] $Errors)

    if (-not $Config.CollectPrimoCache) { return $null }

    $rxpcc = Resolve-RxpccPath -Config $Config
    if (-not $rxpcc) {
        return [ordered]@{
            available = $false
            version   = $null
            reason    = 'PrimoCache does not appear to be installed on this host (rxpcc.exe not found).'
            caches    = @()
        }
    }

    $run = {
        param($arguments)
        $output = & $rxpcc @arguments 2>&1 | ForEach-Object { [string]$_ }
        [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = @($output) }
    }

    try {
        $status = & $run @('status')

        # Exit code 3 with this wording is the GUI holding the single-instance lock.
        $text = ($status.Lines -join "`n")
        if ($text -match 'Multiple Instances|another instance|GUI is running') {
            return [ordered]@{
                available = $false
                version   = $null
                reason    = 'The PrimoCache GUI is open. rxpcc cannot run at the same time, so statistics are unavailable until the GUI is closed.'
                caches    = @()
            }
        }
        if ($status.ExitCode -ne 0 -and $status.Lines.Count -eq 0) {
            throw "rxpcc status exited with code $($status.ExitCode)"
        }

        $caches = ConvertFrom-RxpccStatus -Lines $status.Lines
        $volumes = @()
        $perf = $null
        $version = ''

        try { $volumes = ConvertFrom-RxpccVolumeList -Lines (& $run @('ls')).Lines }
        catch { $Errors.Add((New-CollectorError -Collector 'primocache' -Message 'rxpcc ls failed' -Detail $_.Exception.Message)) }

        try {
            $perfResult = & $run @('perf')
            $perf = ConvertFrom-RxpccPerf -Lines $perfResult.Lines
            if (-not $perf.recognised) {
                $Errors.Add((New-CollectorError -Collector 'primocache' -Message 'rxpcc perf output was not recognised, so hit rates are not reported. Send the output to have the parser matched to this version.'))
            }
        }
        catch { $Errors.Add((New-CollectorError -Collector 'primocache' -Message 'rxpcc perf failed' -Detail $_.Exception.Message)) }

        try {
            $versionLines = (& $run @('ver')).Lines
            if ($versionLines -and ($versionLines -join ' ') -match '(?<v>\d+\.\d+(\.\d+)*)') { $version = $Matches['v'] }
        }
        catch { }

        return Join-PrimoCacheReport -Caches $caches -Volumes $volumes -Perf $perf -Version $version
    }
    catch {
        $Errors.Add((New-CollectorError -Collector 'primocache' -Message $_.Exception.Message))
        return [ordered]@{
            available = $false
            version   = $null
            reason    = "rxpcc could not be queried: $($_.Exception.Message)"
            caches    = @()
        }
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
