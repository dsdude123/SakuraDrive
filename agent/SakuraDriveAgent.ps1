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
                    # A disk mounted into a folder rather than given a letter - the
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

    # Fetched once and matched by DeviceId rather than passing -DeviceNumber: that
    # parameter is missing from the Storage module on Windows Server 2019 with Windows
    # PowerShell 5.1, which is what this actually runs on.
    $allPhysical = @()
    try { $allPhysical = @(Get-PhysicalDisk -ErrorAction Stop) }
    catch {
        $Errors.Add((New-CollectorError -Collector 'storage-reliability' -Message 'Get-PhysicalDisk failed, so reliability counters are unavailable' -Detail $_.Exception.Message))
    }

    foreach ($disk in $PhysicalDisks) {
        $key = Get-DeviceKey -SerialNumber $disk.serialNumber -DeviceId $disk.deviceId
        if ($covered.ContainsKey($key)) { continue }
        try {
            $number = if ($disk.deviceId -match '(\d+)$') { [int]$Matches[1] } else { $null }
            if ($null -eq $number) { continue }
            $physical = $allPhysical | Where-Object { [string]$_.DeviceId -eq [string]$number } | Select-Object -First 1
            if (-not $physical) { continue }
            $counter = $physical | Get-StorageReliabilityCounter -ErrorAction Stop
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
        A pool is whatever `dpcmd list-poolparts` says is one. Nothing else is reliable:
        Windows reports a DrivePool volume's filesystem as NTFS, not as the driver name,
        so any check on the filesystem string finds no pools on a host that plainly has
        one. So every lettered volume is probed with dpcmd and a pool is a volume dpcmd
        answers for. That is a handful of cheap invocations once per report, and it needs
        no heuristic at all.

        dpcmd identifies parts only by NT device path, so each is matched back to a
        volume by finding which one holds its PoolPart folder.

        Without dpcmd, parts are still discovered from the PoolPart folders themselves;
        the pool they belong to then has to come from the UI, which is why the pool id
        is a field the operator can set.
    #>
    param($Config, [array] $Volumes, [System.Collections.Generic.List[object]] $Errors)

    $result = [ordered]@{ pools = @(); duplication = @() }
    if (-not $Config.CollectDrivePool) { return $result }

    $dpcmd = Resolve-DpcmdPath -Config $Config
    if (-not $dpcmd) {
        $Errors.Add((New-CollectorError -Collector 'dpcmd' -Message 'dpcmd.exe not found. Pool parts will be discovered from PoolPart folders, but pool membership and duplication settings need to be set in the web interface.'))
    }

    # Ask dpcmd about every lettered volume; the ones it answers for are the pools.
    $lettered = @($Volumes | Where-Object { $_.driveLetter })
    $poolVolumes = New-Object System.Collections.Generic.List[object]
    $partsByLetter = @{}

    if ($dpcmd) {
        foreach ($volume in $lettered) {
            $root = "$($volume.driveLetter):\"
            try {
                $lines = & $dpcmd list-poolparts $root 2>&1 | ForEach-Object { [string]$_ }
                $found = ConvertFrom-DpcmdPoolParts -Lines $lines
                if ($found.Count -gt 0 -and $found[0].poolId) {
                    $poolVolumes.Add($volume)
                    $partsByLetter[$volume.driveLetter] = $found
                }
            }
            catch {
                # Not a pool, or dpcmd refused. Either way this volume is simply not one;
                # only say something if nothing turns out to be a pool at all.
                Write-AgentLog -Message "dpcmd list-poolparts $root : $($_.Exception.Message)" -Level 'DEBUG' -Config $Config
            }
        }
    }

    if ($poolVolumes.Count -eq 0) {
        $checked = ($lettered | ForEach-Object { "$($_.driveLetter):" }) -join ' '
        $reason = if ($dpcmd) {
            "dpcmd reported no pool for any of $checked. If DrivePool is installed and running, send the output of 'dpcmd list-poolparts J:\' so the parser can be matched to your version."
        }
        else {
            "dpcmd.exe was not found, so pools cannot be identified. Set DpcmdPath in agent.config.json."
        }
        $Errors.Add((New-CollectorError -Collector 'drivepool' -Message $reason))
        return $result
    }

    $pools = New-Object System.Collections.Generic.List[object]
    $duplication = New-Object System.Collections.Generic.List[object]

    foreach ($poolVolume in $poolVolumes) {
        $root = "$($poolVolume.driveLetter):\"
        $poolId = ''
        $parts = @()

        if ($partsByLetter.ContainsKey($poolVolume.driveLetter)) {
            $parts = $partsByLetter[$poolVolume.driveLetter]
            if ($parts.Count -gt 0 -and $parts[0].poolId) { $poolId = $parts[0].poolId }
            $parts = Resolve-PoolPartVolume -Parts $parts -Volumes $Volumes -TestPath {
                    param($path) Test-Path -LiteralPath $path -PathType Container
                }
        }

        if (-not $poolId) { $poolId = if ($poolVolume.volumeId) { $poolVolume.volumeId } else { $root } }

        if ($parts.Count -eq 0) {
            $parts = Find-PoolPartFolders -Volumes $Volumes -Errors $Errors -PoolLetters @($poolVolumes | ForEach-Object { $_.driveLetter })
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
    param(
        [array] $Volumes,
        [System.Collections.Generic.List[object]] $Errors,
        [string[]] $PoolLetters = @()
    )

    $parts = New-Object System.Collections.Generic.List[object]
    foreach ($volume in $Volumes) {
        if ($PoolLetters -contains $volume.driveLetter) { continue }
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
        learn by descending - so the walk stops there. On a pool whose duplication is
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
        rxpcc refuses to run while the PrimoCache GUI is open - it exits with a
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
            # -a covers every cached volume; without it only one block comes back.
            $perfResult = & $run @('perf', '-a')
            $perf = ConvertFrom-RxpccPerf -Lines $perfResult.Lines
            if (-not $perf.recognised) {
                $Errors.Add((New-CollectorError -Collector 'primocache' -Message 'rxpcc perf output was not recognised, so cache statistics are not reported. Send the output to have the parser matched to this version.'))
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
    param($Config, [string] $DistributionVersion = '', [array] $Notices = @())

    $errors = New-Object System.Collections.Generic.List[object]
    foreach ($notice in @($Notices)) { $errors.Add($notice) }

    $physicalDisks = Get-PhysicalDiskInventory -Errors $errors
    $volumes = Get-VolumeInventory -Errors $errors
    $smart = Get-SmartInventory -Config $Config -PhysicalDisks $physicalDisks -Errors $errors
    $poolData = Get-PoolInventory -Config $Config -Volumes $volumes -Errors $errors
    $performance = Get-PerformanceInventory -Config $Config -Errors $errors
    $primoCache = Get-PrimoCacheInventory -Config $Config -Errors $errors

    New-AgentReport -Hostname $env:COMPUTERNAME `
        -IntervalSeconds ([int]$Config.IntervalSeconds) `
        -DistributionVersion $DistributionVersion `
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
    if (-not $Config.SkipCertificateCheck) { return Invoke-RestMethod @parameters }

    # -SkipCertificateCheck does not exist in Windows PowerShell 5.1, which is what ships
    # with Windows Server. There the only way is the global validation callback, so it is
    # set for this one call and put back afterwards rather than left off for the process.
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        $parameters['SkipCertificateCheck'] = $true
        return Invoke-RestMethod @parameters
    }

    $previous = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
    try {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
        return Invoke-RestMethod @parameters
    }
    finally {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $previous
    }
}

function Invoke-AgentApi {
    <#
    .SYNOPSIS
        One authenticated call to the server.
    #>
    param($Config, [string] $Path, [string] $Method = 'Post', $Body = $null)

    $parameters = @{
        Uri         = "$(([string]$Config.ServerUrl).TrimEnd('/'))$Path"
        Method      = $Method
        ContentType = 'application/json'
        Headers     = @{ Authorization = "Bearer $($Config.Token)" }
        TimeoutSec  = [int]$Config.TimeoutSeconds
    }
    if ($null -ne $Body) { $parameters['Body'] = ($Body | ConvertTo-Json -Depth 8 -Compress) }
    if ($Config.SkipCertificateCheck -and $PSVersionTable.PSVersion.Major -ge 6) {
        $parameters['SkipCertificateCheck'] = $true
    }
    Invoke-RestMethod @parameters
}

function Invoke-CatalogScanJob {
    <#
    .SYNOPSIS
        Walk a root the container cannot see, a batch at a time.
    .DESCRIPTION
        Stops when the server says stop. The agent knows nothing about I/O windows: it
        posts a batch, and the reply either says keep going or says enough. That is what
        keeps the schedule in one place -- on the server, where it is configured -- while
        the reading happens here, where the disks actually are.

        Whatever the outcome, the cursor goes back with it, so the next window resumes at
        the directory this one stopped on rather than re-walking the tree.
    #>
    param($Config, $Job)

    $worklist = @('')
    if ($Job.cursor -and $Job.cursor.PSObject.Properties['worklist'] -and $Job.cursor.worklist) {
        $worklist = @($Job.cursor.worklist)
    }

    $filesSeen = 0
    $bytesSeen = 0
    $dirsDone = 0
    $state = 'completed'

    while ($true) {
        $batch = Get-CatalogBatch -RootPath $Job.hostPath -Worklist $worklist `
            -IncludeGlobs @($Job.includeGlobs) -ExcludeGlobs @($Job.excludeGlobs) `
            -BatchSize ([int]$Job.batchSize)

        $worklist = @($batch.worklist)
        $dirsDone += $batch.dirsDone
        $filesSeen += $batch.files.Count
        foreach ($file in $batch.files) { $bytesSeen += $file.sizeBytes }

        $response = Invoke-AgentApi -Config $Config -Path "/api/agent/jobs/$($Job.jobId)/batch" -Body ([ordered]@{
                entries       = @($batch.files)
                errors        = @($batch.errors)
                cursor        = [ordered]@{ worklist = $worklist }
                dirsDone      = $dirsDone
                dirsRemaining = $batch.dirsRemaining
            })

        if ($batch.finished) { break }
        if (-not (Test-AgentJobContinue -Response $response)) { $state = 'paused'; break }
    }

    Invoke-AgentApi -Config $Config -Path "/api/agent/jobs/$($Job.jobId)/finish" -Body ([ordered]@{
            state     = $state
            cursor    = [ordered]@{ worklist = $worklist }
            filesSeen = $filesSeen
            bytesSeen = $bytesSeen
            dirsDone  = $dirsDone
        }) | Out-Null

    return [ordered]@{ state = $state; filesSeen = $filesSeen; bytesSeen = $bytesSeen }
}

function Invoke-CatalogHashJob {
    <#
    .SYNOPSIS
        Hash the files the server named, stopping when it says to.
    #>
    param($Config, $Job)

    $files = @($Job.files)
    $hashed = 0
    $state = 'completed'
    $pending = [System.Collections.Generic.List[object]]::new()
    $root = ([string]$Job.hostPath).TrimEnd('\')

    foreach ($file in $files) {
        $absolute = Join-Path $root ($file.relPath -replace '/', '\')
        $pending.Add((Get-CatalogFileHash -FileId ([int]$file.fileId) -Path $absolute -Algorithm $Job.hashAlgorithm))
        $hashed++

        # Post in small batches so a closing window is honoured promptly: a single
        # large file can take minutes, and the window edge should not wait for the lot.
        if ($pending.Count -ge 25 -or $hashed -eq $files.Count) {
            $response = Invoke-AgentApi -Config $Config -Path "/api/agent/jobs/$($Job.jobId)/batch" -Body ([ordered]@{
                    hashes        = @($pending)
                    dirsDone      = $hashed
                    dirsRemaining = ($files.Count - $hashed)
                })
            $pending.Clear()
            if (-not (Test-AgentJobContinue -Response $response) -and $hashed -lt $files.Count) {
                $state = 'paused'; break
            }
        }
    }

    Invoke-AgentApi -Config $Config -Path "/api/agent/jobs/$($Job.jobId)/finish" -Body ([ordered]@{
            state     = $state
            filesSeen = $hashed
            bytesSeen = 0
            dirsDone  = $hashed
        }) | Out-Null

    return [ordered]@{ state = $state; hashed = $hashed }
}

function Invoke-AgentJobs {
    <#
    .SYNOPSIS
        Take whatever work the server has, until it has none.
    .DESCRIPTION
        Jobs exist because some roots cannot be read from inside the container at all -- a
        pool member with no drive letter is invisible to WSL2, and drvfs will not follow a
        folder mount point into another volume. Rather than bending the host's disk layout
        around that, the reading happens here.

        A failure is reported rather than swallowed: the server treats an unfinished scan
        as "changed nothing", never as deletions.
    #>
    param($Config, [int] $MaxJobs = 4)

    for ($taken = 0; $taken -lt $MaxJobs; $taken++) {
        try {
            $claim = Invoke-AgentApi -Config $Config -Path '/api/agent/jobs/claim' -Body ([ordered]@{
                    # The same fallback the report uses. A blank hostname is rejected by
                    # the server, and "400 Bad Request" says nothing about why.
                    hostname     = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { 'unknown-host' }
                    agentVersion = (Get-SakuraDriveAgentVersion)
                })
        }
        catch {
            Write-AgentLog -Message "Could not ask for work: $($_.Exception.Message)" -Level 'WARN' -Config $Config
            return
        }

        $job = Get-AgentJobFromClaim -Response $claim
        if ($null -eq $job) { return }
        Write-AgentLog -Message "Starting $($job.type) for $($job.rootName) ($($job.hostPath))" -Config $Config

        try {
            $result = switch ($job.type) {
                'catalog.scan' { Invoke-CatalogScanJob -Config $Config -Job $job }
                'catalog.hash' { Invoke-CatalogHashJob -Config $Config -Job $job }
                default { throw "The server asked for '$($job.type)', which this agent does not know how to do. Update the agent." }
            }
            Write-AgentLog -Message "Finished $($job.type) for $($job.rootName): $($result.state)" -Config $Config
        }
        catch {
            Write-AgentLog -Message "$($job.type) for $($job.rootName) failed: $($_.Exception.Message)" -Level 'ERROR' -Config $Config
            try {
                Invoke-AgentApi -Config $Config -Path "/api/agent/jobs/$($job.jobId)/finish" -Body ([ordered]@{
                        state = 'failed'; error = $_.Exception.Message
                    }) | Out-Null
            }
            catch { }
            return
        }
    }
}

#region Self update -----------------------------------------------------------

function Get-AgentDistManifest {
    <#
    .SYNOPSIS
        Ask the server what the agent should be.
    #>
    param($Config)

    Invoke-AgentApi -Config $Config -Path '/api/agent/dist' -Method 'Get'
}

function Save-AgentDistFile {
    <#
    .SYNOPSIS
        Download one file from the distribution to a local path.
    .DESCRIPTION
        Raw bytes: the server serves octet-stream and the caller hashes what lands on
        disk, so a proxy that rewrites the body shows up as a refused update rather
        than a broken installation.
    #>
    param($Config, [string] $RelativePath, [string] $Destination)

    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null

    $encoded = [System.Uri]::EscapeDataString($RelativePath)
    $parameters = @{
        Uri             = "$(([string]$Config.ServerUrl).TrimEnd('/'))/api/agent/dist/file?path=$encoded"
        Method          = 'Get'
        Headers         = @{ Authorization = "Bearer $($Config.Token)" }
        TimeoutSec      = [int]$Config.TimeoutSeconds
        OutFile         = $Destination
        UseBasicParsing = $true
    }
    if ($Config.SkipCertificateCheck -and $PSVersionTable.PSVersion.Major -ge 6) {
        $parameters['SkipCertificateCheck'] = $true
    }
    Invoke-WebRequest @parameters | Out-Null
}

function Sync-AgentDistribution {
    <#
    .SYNOPSIS
        Download a whole distribution into a staging directory and verify it.
    .DESCRIPTION
        Nothing touches the installation until every file has arrived, hashed correctly
        and parsed. The staging directory is rebuilt from scratch each time so a half
        finished attempt from a previous run cannot be mistaken for a complete one.

        Returns the list of problems; empty means the staging directory is safe to
        install.
    #>
    param($Config, $Manifest, [string] $StagingPath)

    if (Test-Path -LiteralPath $StagingPath) { Remove-Item -LiteralPath $StagingPath -Recurse -Force }
    New-Item -ItemType Directory -Path $StagingPath -Force | Out-Null

    foreach ($file in @($Manifest.files)) {
        $relative = ([string]$file.path).Replace('/', '\')
        Save-AgentDistFile -Config $Config -RelativePath ([string]$file.path) `
            -Destination (Join-Path $StagingPath $relative)
    }

    Test-AgentDistribution -Directory $StagingPath -Manifest $Manifest
}

function Resolve-AgentUpdateState {
    <#
    .SYNOPSIS
        Settle what happened to the last update, before doing anything else.
    .DESCRIPTION
        A version installed by the previous run is on probation: it has to get as far
        as posting a report before it counts as working. This runs at startup, so a
        version that dies partway through gets a second chance and then gets reverted,
        rather than leaving the host silently broken until somebody notices the
        monitoring stopped.

        Returns the state, which the rest of the run carries and updates.
    #>
    param($Config, [string] $InstallPath)

    $state = Read-AgentUpdateState -InstallPath $InstallPath
    switch (Resolve-AgentUpdateOutcome -State $state) {
        'verify' {
            $state['attempts'] = [int]$state['attempts'] + 1
            Write-AgentLog -Config $Config -Level 'INFO' `
                -Message "Running version $($state.version) on probation (attempt $($state.attempts))."
            return (Write-AgentUpdateState -InstallPath $InstallPath -State $state)
        }
        'rollback' {
            $failed = [string]$state['version']
            Write-AgentLog -Config $Config -Level 'ERROR' `
                -Message "Version $failed failed to complete a run twice; restoring $($state.previousVersion)."
            if (Undo-AgentUpdate -InstallPath $InstallPath) {
                $restored = New-AgentUpdateState -Version ([string]$state['previousVersion']) `
                    -Stage 'confirmed' -BlockedVersion $failed `
                    -BlockedReason "Version $failed did not complete a run after two attempts."
                return (Write-AgentUpdateState -InstallPath $InstallPath -State $restored)
            }
            Write-AgentLog -Config $Config -Level 'ERROR' `
                -Message 'There is nothing to roll back to. Reinstall the agent from the web interface.'
            $state['stage'] = 'confirmed'
            return (Write-AgentUpdateState -InstallPath $InstallPath -State $state)
        }
    }
    $state
}

function Confirm-AgentVersion {
    <#
    .SYNOPSIS
        Mark the running version as working. Called once a report has been accepted.
    #>
    param($Config, [string] $InstallPath, $State)

    if ($null -eq $State) { return $null }
    if ([string]$State['stage'] -ne 'pending') { return $State }

    $State['stage'] = 'confirmed'
    $State['attempts'] = 0
    Write-AgentLog -Config $Config -Message "Version $($State.version) reported successfully; keeping it."
    Write-AgentUpdateState -InstallPath $InstallPath -State $State
}

function Invoke-AgentSelfUpdate {
    <#
    .SYNOPSIS
        Bring the agent up to whatever the server is shipping.
    .DESCRIPTION
        Runs at the end of a cycle, so a host that is about to update still reports its
        disks first. Returns $true when the files were replaced, which means this
        process is now running code that is no longer on disk and should exit: the
        scheduled task starts the new version at the next interval.

        Anything that goes wrong here is a warning, never a failure. A server that
        cannot be reached, a hash that does not match, a file that will not parse - all
        of them leave the working agent exactly as it was.
    #>
    param($Config, [string] $InstallPath, $State)

    $manifest = $null
    try {
        $manifest = Get-AgentDistManifest -Config $Config
    }
    catch {
        Write-AgentLog -Config $Config -Level 'WARN' `
            -Message "Could not ask the server for the current agent: $($_.Exception.Message)"
        return $false
    }
    if ($null -eq $manifest -or -not $manifest.PSObject.Properties['version']) { return $false }

    $available = [string]$manifest.version
    $installed = if ($null -ne $State) { [string]$State['version'] } else { '' }

    if ($installed -eq $available) { return $false }

    if ($null -ne $State -and [string]$State['blockedVersion'] -eq $available) {
        # This exact version already broke this host once. Reporting it as a collector
        # error puts it on the agents page instead of only in a log file nobody reads.
        Write-AgentLog -Config $Config -Level 'WARN' `
            -Message "Not installing $available again: $($State.blockedReason)"
        return $false
    }

    # An installation done by copying files has no state file. Hash what is already
    # there before downloading anything: usually it is already current and there is
    # nothing to do but write the state down.
    if (-not $installed) {
        $problems = Test-AgentDistribution -Directory $InstallPath -Manifest $manifest
        if ($problems.Count -eq 0) {
            Write-AgentUpdateState -InstallPath $InstallPath -State (New-AgentUpdateState `
                    -Version $available -AgentVersion ([string]$manifest.agentVersion) -Stage 'confirmed') | Out-Null
            Write-AgentLog -Config $Config -Message "Agent files already match the server ($available)."
            return $false
        }
    }

    Write-AgentLog -Config $Config -Message "Updating the agent: $(if ($installed) { $installed } else { 'unknown' }) -> $available."

    $stagingPath = Join-Path $InstallPath '.staging'
    try {
        $problems = Sync-AgentDistribution -Config $Config -Manifest $manifest -StagingPath $stagingPath
    }
    catch {
        Write-AgentLog -Config $Config -Level 'WARN' `
            -Message "Download failed, keeping the current agent: $($_.Exception.Message)"
        return $false
    }

    if ($problems.Count -gt 0) {
        # Refusing is the safe outcome: the agent that is running works, and the one
        # that was offered demonstrably does not.
        Write-AgentLog -Config $Config -Level 'ERROR' `
            -Message "Refusing update $available - $($problems -join ' ')"
        return $false
    }

    try {
        if (-not (Save-AgentUpdate -InstallPath $InstallPath -StagingPath $stagingPath -Manifest $manifest)) {
            return $false
        }
        Write-AgentUpdateState -InstallPath $InstallPath -State (New-AgentUpdateState `
                -Version $available -AgentVersion ([string]$manifest.agentVersion) `
                -Stage 'pending' -Attempts 0 -PreviousVersion $installed) | Out-Null
    }
    catch {
        # Writing into Program Files needs the rights the scheduled task has and an
        # interactive run may not. Say which, rather than dying halfway through a swap.
        Write-AgentLog -Config $Config -Level 'ERROR' `
            -Message "Could not install $available into ${InstallPath}: $($_.Exception.Message)"
        return $false
    }

    try { Remove-Item -LiteralPath $stagingPath -Recurse -Force } catch { }

    Write-AgentLog -Config $Config -Message "Installed $available. The next scheduled run uses it."
    $true
}

#endregion

# ---------------------------------------------------------------------------

$config = Read-AgentConfig -Path $ConfigPath
$installPath = $PSScriptRoot

if (-not $DryRun) {
    $problems = Test-AgentConfig -Config $config
    if ($problems.Count -gt 0) {
        foreach ($problem in $problems) { Write-AgentLog -Message $problem -Level 'ERROR' -Config $config }
        exit 1
    }
}

# Settle the last update before collecting anything. A version installed by the previous
# run is on probation until it gets through a cycle, and one that cannot manage that
# twice puts the old files back rather than leaving the host quietly unmonitored.
$updateState = $null
if (-not $DryRun) { $updateState = Resolve-AgentUpdateState -Config $config -InstallPath $installPath }

do {
    $cycleFailed = $false
    try {
        $notices = @()
        $distributionVersion = ''
        if ($null -ne $updateState) {
            $distributionVersion = [string]$updateState['version']
            if ([string]$updateState['blockedVersion']) {
                # Surface a rolled-back update where the operator already looks, rather
                # than only in a log file on the Windows box.
                $notices = @(New-CollectorError -Collector 'self-update' `
                        -Message ([string]$updateState['blockedReason']) `
                        -Detail "Deploy a different build, or delete update-state.json in $installPath to try again.")
            }
        }

        $report = Invoke-AgentCycle -Config $config -DistributionVersion $distributionVersion -Notices $notices

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

            # Getting a report accepted is what "this version works" means. Anything
            # earlier would confirm a build that starts and then falls over.
            $updateState = Confirm-AgentVersion -Config $config -InstallPath $installPath -State $updateState

            # Then take whatever cataloguing work the server has for roots it cannot
            # read itself. Doing it after the report means the server always has fresh
            # pool membership before it decides what to ask for.
            if ($config.CollectCatalogJobs) { Invoke-AgentJobs -Config $config }
        }
    }
    catch {
        Write-AgentLog -Message "Report failed: $($_.Exception.Message)" -Level 'ERROR' -Config $config
        $cycleFailed = $true
    }

    <#
        The update runs whether or not the cycle worked, and that ordering is the whole
        point: an agent too broken to finish a cycle is exactly the one that most needs
        the fix the server is already holding. Putting this inside the try above would
        mean the first bug to throw before it locked the host onto that version for good.

        After the report, though, so a host about to replace itself has said what it can.
    #>
    if (-not $DryRun -and $config.SelfUpdate) {
        try {
            if (Invoke-AgentSelfUpdate -Config $config -InstallPath $installPath -State $updateState) {
                Write-AgentLog -Config $config `
                    -Message 'Exiting so the scheduled task starts the new version.'
                break
            }
        }
        catch {
            Write-AgentLog -Config $config -Level 'WARN' `
                -Message "The update check failed: $($_.Exception.Message)"
        }
    }

    if ($cycleFailed -and -not $Loop) { exit 2 }
    if ($Loop) { Start-Sleep -Seconds ([int]$config.IntervalSeconds) }
} while ($Loop)
