<#
.SYNOPSIS
    Collectors and parsers for the SakuraDrive Windows agent.

.DESCRIPTION
    SMART data, volume labels, StableBit DrivePool membership and duplication settings,
    disk performance counters and PrimoCache statistics all live on the Windows host and
    cannot be read from inside the Linux container that runs SakuraDrive. This module
    collects them and shapes them into the agent report the server expects.

    Everything that parses or transforms data is a pure function so it can be unit
    tested (see agent/tests). The functions that actually touch Windows are thin
    wrappers around those.
#>

Set-StrictMode -Version Latest

$script:AgentVersion = '1.0.0'
$script:ProtocolVersion = 1

function Get-SakuraDriveAgentVersion {
    [CmdletBinding()]
    param()
    $script:AgentVersion
}

#region Configuration ---------------------------------------------------------

function Get-DefaultAgentConfig {
    <#
    .SYNOPSIS
        The defaults every configuration starts from.
    #>
    [CmdletBinding()]
    param()

    [ordered]@{
        ServerUrl            = 'http://localhost:8080'
        Token                = ''
        IntervalSeconds      = 900
        # Where smartctl lives. Left blank, the agent looks in the usual places.
        SmartctlPath         = ''
        # StableBit DrivePool's command line tool, used for pool membership and
        # duplication settings.
        DpcmdPath            = ''
        # PrimoCache's command line tool. It cannot run while the PrimoCache GUI is
        # open, which the agent detects and reports rather than treating as a fault.
        RxpccPath            = ''
        # How deep below each pool root to probe duplication settings. DrivePool
        # inherits downward, so only folders that differ from their parent are
        # reported; a depth of 3 covers a normal media library cheaply.
        DuplicationDepth     = 3
        CollectSmart         = $true
        CollectPerformance   = $true
        CollectDrivePool     = $true
        CollectPrimoCache    = $true
        # Seconds of performance-counter sampling per report.
        PerformanceSamples   = 3
        # Skip TLS validation. Only for a self-signed certificate on a trusted LAN.
        SkipCertificateCheck = $false
        TimeoutSeconds       = 120
        LogPath              = ''
    }
}

function Merge-AgentConfig {
    <#
    .SYNOPSIS
        Overlay a user configuration onto the defaults.
    .DESCRIPTION
        Unknown keys are preserved so a newer configuration file does not lose data
        when read by an older agent.
    #>
    [CmdletBinding()]
    param(
        [Parameter()] $UserConfig
    )

    $merged = Get-DefaultAgentConfig
    if ($null -eq $UserConfig) { return $merged }

    foreach ($key in @($UserConfig.PSObject.Properties.Name)) {
        $merged[$key] = $UserConfig.$key
    }
    $merged
}

function Test-AgentConfig {
    <#
    .SYNOPSIS
        Validate a configuration, returning the list of problems (empty when valid).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Config
    )

    $problems = New-Object System.Collections.Generic.List[string]

    if ([string]::IsNullOrWhiteSpace([string]$Config.ServerUrl)) {
        $problems.Add('ServerUrl is required, for example http://nas:8080')
    }
    elseif (-not ([string]$Config.ServerUrl -match '^https?://')) {
        $problems.Add('ServerUrl must start with http:// or https://')
    }

    if ([string]::IsNullOrWhiteSpace([string]$Config.Token)) {
        $problems.Add('Token is required. Create one under Settings then Agents in the web interface.')
    }

    if ([int]$Config.IntervalSeconds -lt 60) {
        $problems.Add('IntervalSeconds must be at least 60')
    }

    if ([int]$Config.DuplicationDepth -lt 0 -or [int]$Config.DuplicationDepth -gt 10) {
        $problems.Add('DuplicationDepth must be between 0 and 10')
    }

    , $problems.ToArray()
}

#endregion

#region Identity --------------------------------------------------------------

function Get-DeviceKey {
    <#
    .SYNOPSIS
        Canonical identity for a physical disk.
    .DESCRIPTION
        Serial numbers survive a controller swap or a reboot renumbering the devices,
        so they are preferred; the Windows device id is the fallback. Must match the
        server's `deviceKey` exactly.
    #>
    [CmdletBinding()]
    param(
        [string] $SerialNumber,
        [string] $DeviceId
    )

    $serial = if ($null -eq $SerialNumber) { '' } else { $SerialNumber.Trim() }
    if ($serial -and $serial.ToLowerInvariant() -ne 'unknown') {
        return "sn:$($serial.ToUpperInvariant())"
    }
    $device = if ($null -eq $DeviceId) { '' } else { $DeviceId.Trim() }
    if ($device) { return "dev:$($device.ToUpperInvariant())" }
    'dev:unknown'
}

function ConvertTo-PhysicalDrivePath {
    <#
    .SYNOPSIS
        Map a smartctl device name to the Windows device path.
    .DESCRIPTION
        smartctl for Windows exposes disks as /dev/sda, /dev/sdb, ... which correspond
        to \\.\PHYSICALDRIVE0, 1, ... It also accepts /dev/pdN directly. Anything else
        is passed through so an unusual name still identifies the device.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [string] $Name
    )

    if ([string]::IsNullOrWhiteSpace($Name)) { return '' }

    if ($Name -match '^/dev/pd(\d+)$') {
        return "\\.\PHYSICALDRIVE$($Matches[1])"
    }
    if ($Name -match '^/dev/sd([a-z]+)$') {
        # Base-26 with 'a' = 0: sda -> 0, sdz -> 25, sdaa -> 26.
        $letters = $Matches[1]
        $index = 0
        foreach ($char in $letters.ToCharArray()) {
            $index = $index * 26 + ([int][char]$char - [int][char]'a' + 1)
        }
        return "\\.\PHYSICALDRIVE$($index - 1)"
    }
    if ($Name -match '^\\\\\.\\PHYSICALDRIVE\d+$') {
        return $Name.ToUpperInvariant()
    }
    $Name
}

#endregion

#region SMART -----------------------------------------------------------------

function ConvertFrom-SmartctlJson {
    <#
    .SYNOPSIS
        Turn `smartctl --json -a` output into the report shape the server expects.
    .DESCRIPTION
        Handles both ATA attribute tables and NVMe health logs, and tolerates the
        fields smartctl omits for a given device rather than assuming they are present.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowNull()] $Smart,
        [string] $FallbackDeviceId = ''
    )

    if ($null -eq $Smart) { return $null }

    $deviceName = Get-JsonValue $Smart 'device.name'
    $deviceId = if ($deviceName) { ConvertTo-PhysicalDrivePath -Name $deviceName } else { $FallbackDeviceId }
    if (-not $deviceId) { $deviceId = $FallbackDeviceId }
    if (-not $deviceId) { return $null }

    $attributes = @()
    $table = Get-JsonValue $Smart 'ata_smart_attributes.table'
    if ($table) {
        $attributes = @(
            foreach ($row in $table) {
                [ordered]@{
                    id         = [int](Get-JsonValue $row 'id')
                    name       = [string](Get-JsonValue $row 'name')
                    value      = ConvertTo-NullableDouble (Get-JsonValue $row 'value')
                    worst      = ConvertTo-NullableDouble (Get-JsonValue $row 'worst')
                    threshold  = ConvertTo-NullableDouble (Get-JsonValue $row 'thresh')
                    raw        = ConvertTo-NullableDouble (Get-JsonValue $row 'raw.value')
                    rawString  = [string](Get-JsonValue $row 'raw.string')
                    whenFailed = [string](Get-JsonValue $row 'when_failed')
                    flags      = [string](Get-JsonValue $row 'flags.string')
                }
            }
        )
    }

    $nvme = $null
    $nvmeLog = Get-JsonValue $Smart 'nvme_smart_health_information_log'
    if ($nvmeLog) {
        $nvme = [ordered]@{
            availableSpare          = ConvertTo-NullableDouble (Get-JsonValue $nvmeLog 'available_spare')
            availableSpareThreshold = ConvertTo-NullableDouble (Get-JsonValue $nvmeLog 'available_spare_threshold')
            percentageUsed          = ConvertTo-NullableDouble (Get-JsonValue $nvmeLog 'percentage_used')
            mediaErrors             = ConvertTo-NullableDouble (Get-JsonValue $nvmeLog 'media_errors')
            errorLogEntries         = ConvertTo-NullableDouble (Get-JsonValue $nvmeLog 'num_err_log_entries')
            criticalWarning         = ConvertTo-NullableDouble (Get-JsonValue $nvmeLog 'critical_warning')
            dataUnitsRead           = ConvertTo-NullableDouble (Get-JsonValue $nvmeLog 'data_units_read')
            dataUnitsWritten        = ConvertTo-NullableDouble (Get-JsonValue $nvmeLog 'data_units_written')
            unsafeShutdowns         = ConvertTo-NullableDouble (Get-JsonValue $nvmeLog 'unsafe_shutdowns')
        }
    }

    $selfTest = $null
    $selfTestRows = Get-JsonValue $Smart 'ata_smart_self_test_log.standard.table'
    if ($selfTestRows) {
        $latest = @($selfTestRows)[0]
        $passed = Get-JsonValue $latest 'status.passed'
        $selfTest = [ordered]@{
            status            = [string](Get-JsonValue $latest 'status.string')
            # smartctl omits `passed` while a test is still running; only an explicit
            # false means the drive failed.
            failed            = if ($null -eq $passed) { $null } else { -not [bool]$passed }
            lastHours         = ConvertTo-NullableDouble (Get-JsonValue $latest 'lifetime_hours')
            remainingPercent  = ConvertTo-NullableDouble (Get-JsonValue $latest 'status.remaining_percent')
        }
    }

    $temperature = ConvertTo-NullableDouble (Get-JsonValue $Smart 'temperature.current')
    if ($null -eq $temperature -and $nvmeLog) {
        # NVMe reports kelvin in the health log.
        $kelvin = ConvertTo-NullableDouble (Get-JsonValue $nvmeLog 'temperature')
        if ($null -ne $kelvin -and $kelvin -gt 200) { $temperature = [math]::Round($kelvin - 273.15, 0) }
        elseif ($null -ne $kelvin) { $temperature = $kelvin }
    }

    $smartStatus = Get-JsonValue $Smart 'smart_status.passed'

    [ordered]@{
        deviceId             = $deviceId
        serialNumber         = [string](Get-JsonValue $Smart 'serial_number')
        model                = [string](Get-JsonValue $Smart 'model_name')
        firmware             = [string](Get-JsonValue $Smart 'firmware_version')
        source               = 'smartctl'
        smartSupported       = ConvertTo-NullableBool (Get-JsonValue $Smart 'smart_support.available')
        smartEnabled         = ConvertTo-NullableBool (Get-JsonValue $Smart 'smart_support.enabled')
        overallHealthPassed  = ConvertTo-NullableBool $smartStatus
        temperatureC         = $temperature
        powerOnHours         = ConvertTo-NullableDouble (Get-JsonValue $Smart 'power_on_time.hours')
        powerCycles          = ConvertTo-NullableDouble (Get-JsonValue $Smart 'power_cycle_count')
        rotationRate         = ConvertTo-NullableDouble (Get-JsonValue $Smart 'rotation_rate')
        protocol             = [string](Get-JsonValue $Smart 'device.protocol')
        attributes           = $attributes
        nvme                 = $nvme
        selfTest             = $selfTest
    }
}

function ConvertFrom-StorageReliabilityCounter {
    <#
    .SYNOPSIS
        Fallback SMART-ish data from Windows itself.
    .DESCRIPTION
        `Get-StorageReliabilityCounter` exposes a handful of counters without needing
        smartmontools installed. It is far less informative than smartctl — no
        per-attribute table — but it is better than reporting nothing, and it still
        catches wear, temperature and read/write error counts.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowNull()] $Counter,
        [Parameter(Mandatory)] [string] $DeviceId,
        [string] $SerialNumber = '',
        [string] $Model = ''
    )

    if ($null -eq $Counter) { return $null }

    $attributes = New-Object System.Collections.Generic.List[object]
    $wear = ConvertTo-NullableDouble (Get-JsonValue $Counter 'Wear')
    $readErrors = ConvertTo-NullableDouble (Get-JsonValue $Counter 'ReadErrorsUncorrected')
    if ($null -ne $readErrors) {
        # Attribute 187 is "reported uncorrectable errors", the closest equivalent.
        $attributes.Add([ordered]@{
                id = 187; name = 'ReadErrorsUncorrected'; value = $null; worst = $null
                threshold = $null; raw = $readErrors; rawString = "$readErrors"
                whenFailed = ''; flags = ''
            })
    }
    $writeErrors = ConvertTo-NullableDouble (Get-JsonValue $Counter 'WriteErrorsUncorrected')
    if ($null -ne $writeErrors) {
        $attributes.Add([ordered]@{
                id = 184; name = 'WriteErrorsUncorrected'; value = $null; worst = $null
                threshold = $null; raw = $writeErrors; rawString = "$writeErrors"
                whenFailed = ''; flags = ''
            })
    }

    $nvme = $null
    if ($null -ne $wear) {
        $nvme = [ordered]@{
            availableSpare          = $null
            availableSpareThreshold = $null
            percentageUsed          = $wear
            mediaErrors             = $null
            errorLogEntries         = $null
            criticalWarning         = $null
            dataUnitsRead           = $null
            dataUnitsWritten        = $null
            unsafeShutdowns         = $null
        }
    }

    [ordered]@{
        deviceId            = $DeviceId
        serialNumber        = $SerialNumber
        model               = $Model
        firmware            = ''
        source              = 'storage-reliability'
        smartSupported      = $null
        smartEnabled        = $null
        overallHealthPassed = $null
        temperatureC        = ConvertTo-NullableDouble (Get-JsonValue $Counter 'Temperature')
        powerOnHours        = ConvertTo-NullableDouble (Get-JsonValue $Counter 'PowerOnHours')
        powerCycles         = $null
        rotationRate        = $null
        protocol            = ''
        attributes          = @($attributes.ToArray())
        nvme                = $nvme
        selfTest            = $null
    }
}

#endregion

#region DrivePool -------------------------------------------------------------

function ConvertFrom-DpcmdPoolParts {
    <#
    .SYNOPSIS
        Parse `dpcmd list-poolparts <pool>` output into pool part records.
    .DESCRIPTION
        DrivePool 2.3.x prints one block per pool:

            + Pool ID 'd304fce8-5935-49cb-a280-e93bf43d12bd':
              - '\\?\GLOBALROOT\Device\HarddiskVolume2\PoolPart.4f0ccc7c-...' [Device 0]

        Note what is *not* there: no drive letter, no label, no capacity. Parts are
        identified by an NT device path, so the letter and label are resolved separately
        by finding which volume actually holds that PoolPart folder (see
        Resolve-PoolPartVolume). Each part is tagged with the pool it belongs to, which
        is what lets the server group parts by pool without the operator saying so.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [AllowNull()] [string[]] $Lines
    )

    $parts = New-Object System.Collections.Generic.List[object]
    if ($null -eq $Lines) { return , $parts.ToArray() }

    $poolId = ''
    foreach ($rawLine in $Lines) {
        if ($null -eq $rawLine) { continue }
        $line = $rawLine.Trim()
        if (-not $line) { continue }

        if ($line -match "^\+?\s*Pool ID\s*'(?<pool>[^']+)'") {
            $poolId = $Matches['pool']
            continue
        }

        # ` - '<device path>\PoolPart.<guid>' [Device N]`
        if ($line -match "^-?\s*'(?<path>[^']*PoolPart\.(?<guid>[0-9a-fA-F-]+))'\s*(\[\s*Device\s*(?<device>\d+)\s*\])?") {
            # Capture everything from this match before running another one: a later
            # -match replaces $Matches wholesale.
            $devicePath = $Matches['path']
            $partGuid = $Matches['guid']
            $deviceIndex = if ($Matches['device']) { [int]$Matches['device'] } else { $null }

            $volumeDevice = ''
            if ($devicePath -match '(?<vol>\\Device\\HarddiskVolume\d+)') {
                $volumeDevice = $Matches['vol']
            }
            $parts.Add([ordered]@{
                    partId          = "PoolPart.$partGuid"
                    poolId          = $poolId
                    name            = ''
                    volumeId        = ''
                    volumeLabel     = ''
                    driveLetter     = $null
                    path            = $devicePath
                    volumeDevice    = $volumeDevice
                    deviceIndex     = $deviceIndex
                    sizeBytes       = $null
                    freeBytes       = $null
                    usedBytes       = $null
                    physicalDiskId  = $null
                    missing         = $false
                    readOnly        = $false
                })
            continue
        }

        # DrivePool marks an absent disk in the part list rather than omitting it.
        if ($line -match 'missing|not\s+connected|unavailable' -and $parts.Count -gt 0) {
            $parts[$parts.Count - 1].missing = $true
        }
    }

    , $parts.ToArray()
}

function ConvertFrom-DpcmdDuplicationDetail {
    <#
    .SYNOPSIS
        Parse the whole of `dpcmd get-duplication <path>` output.
    .DESCRIPTION
        DrivePool 2.3.x prints:

            Found '\\?\J:\Tier1\'
              Expected number of copies: 2
              Found number of copies: 14
              Is directory: True
              Has multiple sub-duplication counts: False

        Two fields matter beyond the level itself:

        `Has multiple sub-duplication counts` is False when everything below this folder
        shares one duplication level, which means there is nothing to learn by
        descending — the probe can prune the whole subtree instead of walking it.

        `Found number of copies` is only a real copy count for a *file*. For a directory
        it counts how many pool parts have that folder, which on a 14-disk pool reads as
        14 regardless of the duplication setting, so it is not treated as an observed
        duplication level unless `Is directory` is False.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [AllowNull()] [string[]] $Lines
    )

    $result = [ordered]@{
        path                = ''
        expectedCopies      = $null
        foundCopies         = $null
        isDirectory         = $null
        hasMixedSubCounts   = $null
        found               = $false
    }
    if ($null -eq $Lines) { return $result }

    foreach ($rawLine in $Lines) {
        if ($null -eq $rawLine) { continue }
        $line = $rawLine.Trim()
        if (-not $line) { continue }

        if ($line -match "^Found\s+'(?<path>[^']+)'") {
            $result.path = $Matches['path']
            $result.found = $true
            continue
        }
        if ($line -match '^Expected number of copies\s*:\s*(?<n>\d+)') {
            $result.expectedCopies = [int]$Matches['n']
            continue
        }
        if ($line -match '^Found number of copies\s*:\s*(?<n>\d+)') {
            $result.foundCopies = [int]$Matches['n']
            continue
        }
        if ($line -match '^Is directory\s*:\s*(?<v>True|False)') {
            $result.isDirectory = ($Matches['v'] -eq 'True')
            continue
        }
        if ($line -match '^Has multiple sub-duplication counts\s*:\s*(?<v>True|False)') {
            $result.hasMixedSubCounts = ($Matches['v'] -eq 'True')
            continue
        }
    }

    $result
}

function ConvertFrom-DpcmdDuplication {
    <#
    .SYNOPSIS
        The configured duplication level from `dpcmd get-duplication`, or $null.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [AllowNull()] [string[]] $Lines
    )

    (ConvertFrom-DpcmdDuplicationDetail -Lines $Lines).expectedCopies
}

function Resolve-PoolPartVolume {
    <#
    .SYNOPSIS
        Attach drive letters, labels and capacities to parts that dpcmd named only by
        NT device path.
    .DESCRIPTION
        `dpcmd list-poolparts` identifies a part as
        `\\?\GLOBALROOT\Device\HarddiskVolume8\PoolPart.<guid>` — no letter, no label.
        Rather than translating NT device names (which needs QueryDosDevice and still
        misses volumes with no letter), each part is matched by looking for its
        PoolPart folder at the root of every known volume. The folder name contains a
        GUID, so exactly one volume can hold it.

        `TestPath` is injected so the matching logic can be tested without a filesystem;
        in production it is `Test-Path`.
    .OUTPUTS
        The parts, with volume details filled in and `missing` set where no volume on
        this host holds the folder — which is precisely a pool disk that has dropped out.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyCollection()] [array] $Parts,
        [Parameter(Mandatory)] [AllowEmptyCollection()] [array] $Volumes,
        [Parameter(Mandatory)] [scriptblock] $TestPath
    )

    foreach ($part in $Parts) {
        $matched = $null
        foreach ($volume in $Volumes) {
            # A pool drive contains the pooled view, not the PoolPart folders.
            if ($volume.fileSystem -match 'covefs') { continue }

            # On an array with more disks than there are drive letters, pool members
            # are normally mounted without one — so try the volume's own GUID path and
            # any folder mount point as well, not just `X:\`.
            $roots = New-Object System.Collections.Generic.List[string]
            if ($volume.driveLetter) { $roots.Add("$($volume.driveLetter):\") }
            if ($volume.path) { $roots.Add(([string]$volume.path).TrimEnd('\') + '\') }
            foreach ($mountPoint in @($volume.mountPoints)) {
                if ($mountPoint) { $roots.Add(([string]$mountPoint).TrimEnd('\') + '\') }
            }

            foreach ($root in ($roots | Select-Object -Unique)) {
                $candidate = "$root$($part.partId)"
                if (& $TestPath $candidate) {
                    $matched = $volume
                    $part.path = $candidate
                    break
                }
            }
            if ($null -ne $matched) { break }
        }

        if ($null -eq $matched) {
            # dpcmd listed the part but no volume here holds it: the disk is gone.
            $part.missing = $true
            continue
        }

        $part.driveLetter = $matched.driveLetter
        $part.volumeId = $matched.volumeId
        $part.volumeLabel = $matched.label
        if (-not $part.name) { $part.name = $matched.label }
        $part.sizeBytes = $matched.sizeBytes
        $part.freeBytes = $matched.freeBytes
        if ($null -ne $matched.sizeBytes -and $null -ne $matched.freeBytes) {
            $part.usedBytes = $matched.sizeBytes - $matched.freeBytes
        }
        if ($matched.physicalDiskIds -and $matched.physicalDiskIds.Count -gt 0) {
            $part.physicalDiskId = $matched.physicalDiskIds[0]
        }
    }

    , $Parts
}

function Select-ChangedDuplicationRules {
    <#
    .SYNOPSIS
        Reduce a folder/level map to the minimal rule set.
    .DESCRIPTION
        DrivePool inherits duplication downward, so a folder whose level matches its
        nearest configured ancestor adds nothing. Reporting only the differences keeps
        the rule list the size a human would have written.
    .PARAMETER Map
        Ordered hashtable of pool-relative path (empty string = pool root) to level.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [hashtable] $Map,
        [string] $PoolId = ''
    )

    $paths = @($Map.Keys) | Sort-Object { ($_ -split '/').Count }, { $_ }
    $effective = @{}
    $rules = New-Object System.Collections.Generic.List[object]

    foreach ($path in $paths) {
        $level = [int]$Map[$path]
        $inherited = $null

        if ($path -ne '') {
            $segments = $path -split '/'
            for ($i = $segments.Count - 1; $i -ge 0; $i--) {
                $ancestor = ($segments[0..($i - 1)] -join '/')
                if ($i -eq 0) { $ancestor = '' }
                if ($effective.ContainsKey($ancestor)) {
                    $inherited = [int]$effective[$ancestor]
                    break
                }
            }
        }

        $effective[$path] = $level
        if ($null -ne $inherited -and $inherited -eq $level) { continue }

        $rules.Add([ordered]@{
                poolId = $PoolId
                path   = $path
                level  = $level
            })
    }

    , $rules.ToArray()
}

function Get-PoolRelativePath {
    <#
    .SYNOPSIS
        Convert an absolute Windows path under a pool root to a pool-relative POSIX path.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [string] $Root,
        [Parameter(Mandatory)] [AllowEmptyString()] [string] $FullPath
    )

    $normalizedRoot = $Root.TrimEnd('\', '/')
    $normalizedPath = $FullPath.TrimEnd('\', '/')
    if ($normalizedPath.Length -le $normalizedRoot.Length) { return '' }
    if (-not $normalizedPath.ToLowerInvariant().StartsWith($normalizedRoot.ToLowerInvariant())) {
        return ($normalizedPath -replace '\\', '/').TrimStart('/')
    }
    ($normalizedPath.Substring($normalizedRoot.Length) -replace '\\', '/').Trim('/')
}

#endregion

#region PrimoCache ------------------------------------------------------------

function ConvertFrom-RxpccStatus {
    <#
    .SYNOPSIS
        Parse `rxpcc status` into cache-task records.
    .DESCRIPTION
        PrimoCache prints one block per cache task, then one block per cached volume:

            Cache Task #1 {507EEFF9-...}
            ----------------------------------------------------
              Status: Active
              Level-1 Cache: 262144MB
                MM: 262144MB, IM: 0MB
              Level-2 Cache: 953618MB
                Storage: {D4CEAE5C-...}
              Block Size: 32KB
              Strategy: Read & Write
              Defer-Write: Enabled
                Latency: 300s
              Overhead: 12.48GB

            Volume #8: Cache (Active)
              Strategy: Read & Write

        Indentation is not reliable across versions, so blocks are delimited by their
        headers and every key is matched on its own. Sizes are normalised to bytes.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [AllowNull()] [string[]] $Lines
    )

    $caches = New-Object System.Collections.Generic.List[object]
    if ($null -eq $Lines) { return , $caches.ToArray() }

    $current = $null
    $section = ''   # 'l1' or 'l2' — which cache level the indented keys belong to

    $flush = {
        if ($null -ne $current) { $caches.Add($current) }
    }

    foreach ($rawLine in $Lines) {
        if ($null -eq $rawLine) { continue }
        $line = $rawLine.Trim()
        if (-not $line -or $line -match '^-{3,}$') { continue }

        if ($line -match '^Cache Task\s*#(?<index>\d+)\s*(?<guid>\{[^}]+\})?') {
            & $flush
            $section = ''
            $current = [ordered]@{
                name               = "Cache Task #$($Matches['index'])"
                level              = ''
                targetVolumes      = @()
                cacheSizeBytes     = $null
                usedBytes          = $null
                readHitRate        = $null
                writeHitRate       = $null
                readHits           = $null
                readMisses         = $null
                writeHits          = $null
                writeMisses        = $null
                deferredWriteBytes = $null
                pendingWriteBlocks = $null
                freeDeferredBlocks = $null
                status             = ''
                blockSize          = ''
                strategy           = ''
                deferWrite         = $null
                taskId             = if ($Matches['guid']) { $Matches['guid'] } else { '' }
                level1SizeBytes    = $null
                level2SizeBytes    = $null
            }
            continue
        }

        # A cached volume belongs to the task above it.
        if ($line -match '^Volume\s*#(?<index>\d+)\s*:\s*(?<name>[^(]+)?\s*(\((?<state>[^)]+)\))?') {
            if ($null -ne $current) {
                $current.targetVolumes = @($current.targetVolumes) + "#$($Matches['index'])"
            }
            $section = 'volume'
            continue
        }

        if ($null -eq $current) { continue }

        # Each `Volume #N` block repeats `Level-2 Cache: Enabled` and the strategy
        # keys. Those describe the volume, not the task, and must not overwrite the
        # task's parsed sizes with an unparseable word.
        if ($section -ne 'volume') {
            if ($line -match '^Level-1 Cache\s*:\s*(?<size>\S+)') {
                $section = 'l1'
                $current.level1SizeBytes = ConvertFrom-SizeString $Matches['size']
                continue
            }
            if ($line -match '^Level-2 Cache\s*:\s*(?<size>\S+)') {
                $section = 'l2'
                $current.level2SizeBytes = ConvertFrom-SizeString $Matches['size']
                continue
            }
            if ($line -match '^Status\s*:\s*(?<v>.+)$') { $current.status = $Matches['v'].Trim(); continue }
            if ($line -match '^Block Size\s*:\s*(?<v>.+)$') { $current.blockSize = $Matches['v'].Trim(); continue }
            if ($line -match '^Strategy\s*:\s*(?<v>.+)$') { $current.strategy = $Matches['v'].Trim(); continue }
            if ($line -match '^Defer-Write\s*:\s*(?<v>.+)$') {
                $current.deferWrite = ($Matches['v'].Trim() -match '^Enabled')
                continue
            }
            if ($line -match '^Overhead\s*:\s*(?<size>\S+)') {
                $current.usedBytes = ConvertFrom-SizeString $Matches['size']
                continue
            }
        }
    }

    & $flush

    # The reported cache size is L1 plus L2, which is what the volume is actually
    # backed by; the individual levels are kept for the drive detail page.
    foreach ($cache in $caches) {
        $total = 0
        if ($null -ne $cache.level1SizeBytes) { $total += $cache.level1SizeBytes }
        if ($null -ne $cache.level2SizeBytes) { $total += $cache.level2SizeBytes }
        if ($total -gt 0) { $cache.cacheSizeBytes = $total }
        $cache.level = if ($null -ne $cache.level2SizeBytes -and $cache.level2SizeBytes -gt 0) { 'L1+L2' } else { 'L1' }
    }

    , $caches.ToArray()
}

function ConvertFrom-RxpccVolumeList {
    <#
    .SYNOPSIS
        Parse `rxpcc ls` into volume records.
    .DESCRIPTION
        The listing is column-formatted and indented under each disk:

            Disk4      ATA     ST8000VN004-3CP1        7452.04GB
              Vol #7   Local Volume                    16MB
              Vol #8   DRIVEPOOL4   NTFS  272.14GB/7452.02GB  4KB  1

        The trailing column is the cache task number, present only for cached volumes.
        This is the one place the agent learns which PrimoCache task fronts which
        labelled volume, which is what lets the interface say "the cache in front of
        DRIVEPOOL4" instead of "cache task 1".
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [AllowNull()] [string[]] $Lines
    )

    $volumes = New-Object System.Collections.Generic.List[object]
    if ($null -eq $Lines) { return , $volumes.ToArray() }

    $disk = ''
    foreach ($rawLine in $Lines) {
        if ($null -eq $rawLine) { continue }
        $line = $rawLine.TrimEnd()
        if (-not $line.Trim()) { continue }
        if ($line -match '^-{3,}' -or $line -match '^\s*Index\s+Name') { continue }

        if ($line -match '^(?<disk>Disk\d+)\s+(?<model>.+?)\s{2,}(?<size>[\d.]+[KMGTP]?B)\s*$') {
            $disk = $Matches['disk']
            continue
        }

        if ($line -match '^\s+Vol\s*#(?<index>\d+)\s+(?<rest>.+)$') {
            $rest = $Matches['rest'].Trim()
            $entry = [ordered]@{
                disk        = $disk
                index       = [int]$Matches['index']
                label       = ''
                driveLetter = $null
                fileSystem  = ''
                freeBytes   = $null
                sizeBytes   = $null
                cacheTask   = $null
            }

            # `NAME (L:)  NTFS  free/capacity  cluster  cacheTask`
            if ($rest -match '^(?<name>.+?)\s{2,}(?<fs>[A-Za-z0-9]+)\s+(?<free>[\d.]+[KMGTP]?B)/(?<size>[\d.]+[KMGTP]?B)(\s+(?<cluster>\S+))?(\s+(?<task>\d+))?\s*$') {
                $name = $Matches['name'].Trim()
                if ($name -match '^(?<label>.*?)\s*\((?<letter>[A-Za-z]):\)$') {
                    $entry.label = $Matches['label'].Trim()
                    $entry.driveLetter = $Matches['letter'].ToUpperInvariant()
                }
                else {
                    $entry.label = $name
                }
                $entry.fileSystem = $Matches['fs']
                $entry.freeBytes = ConvertFrom-SizeString $Matches['free']
                $entry.sizeBytes = ConvertFrom-SizeString $Matches['size']
                if ($Matches['task']) { $entry.cacheTask = [int]$Matches['task'] }
            }
            else {
                # `Local Volume  16MB` — a recovery partition with no filesystem shown.
                $entry.label = ($rest -replace '\s{2,}.*$', '').Trim()
            }

            $volumes.Add($entry)
            continue
        }
    }

    , $volumes.ToArray()
}

function ConvertFrom-RxpccPerf {
    <#
    .SYNOPSIS
        Parse `rxpcc perf` into hit-rate statistics, keyed by whatever the tool labels.
    .DESCRIPTION
        The exact layout of `perf` is not documented publicly and varies by version, so
        this reads defensively: any `Label: value` pair whose label mentions hits,
        misses or a rate is captured, and percentages and counts are normalised. A
        version whose wording is not recognised yields an empty result rather than a
        wrong one — the caller then reports statistics as unavailable, which is honest,
        instead of inventing a hit rate.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [AllowNull()] [string[]] $Lines
    )

    $result = [ordered]@{
        readHitRate  = $null
        writeHitRate = $null
        readHits     = $null
        readMisses   = $null
        writeHits    = $null
        writeMisses  = $null
        recognised   = $false
    }
    if ($null -eq $Lines) { return $result }

    foreach ($rawLine in $Lines) {
        if ($null -eq $rawLine) { continue }
        $line = $rawLine.Trim()
        if (-not $line) { continue }
        if ($line -notmatch '^(?<key>[^:]+?)\s*:\s*(?<value>.+)$') { continue }

        $key = $Matches['key'].Trim().ToLowerInvariant()
        $value = $Matches['value'].Trim()

        $percent = $null
        if ($value -match '(?<n>[\d.]+)\s*%') { $percent = [double]$Matches['n'] / 100 }
        $count = $null
        if ($value -match '^(?<n>[\d,]+)\s*$') { $count = [double]($Matches['n'] -replace ',', '') }

        if ($key -match 'read' -and $key -match 'hit' -and $key -match 'rate|ratio') {
            $result.readHitRate = $percent; $result.recognised = $true; continue
        }
        if ($key -match 'write' -and $key -match 'hit' -and $key -match 'rate|ratio') {
            $result.writeHitRate = $percent; $result.recognised = $true; continue
        }
        if ($key -match 'read' -and $key -match 'hit') {
            $result.readHits = $count; $result.recognised = $true; continue
        }
        if ($key -match 'read' -and $key -match 'miss') {
            $result.readMisses = $count; $result.recognised = $true; continue
        }
        if ($key -match 'write' -and $key -match 'hit') {
            $result.writeHits = $count; $result.recognised = $true; continue
        }
        if ($key -match 'write' -and $key -match 'miss') {
            $result.writeMisses = $count; $result.recognised = $true; continue
        }
    }

    # Derive a rate when only raw counts were reported.
    if ($null -eq $result.readHitRate -and $null -ne $result.readHits -and $null -ne $result.readMisses) {
        $total = $result.readHits + $result.readMisses
        if ($total -gt 0) { $result.readHitRate = $result.readHits / $total }
    }
    if ($null -eq $result.writeHitRate -and $null -ne $result.writeHits -and $null -ne $result.writeMisses) {
        $total = $result.writeHits + $result.writeMisses
        if ($total -gt 0) { $result.writeHitRate = $result.writeHits / $total }
    }

    $result
}

function Join-PrimoCacheReport {
    <#
    .SYNOPSIS
        Combine `status`, `ls` and `perf` output into the report section the server takes.
    .DESCRIPTION
        Names each cache task after the labelled volumes it fronts, so the interface can
        say "L1+L2 in front of DRIVEPOOL4, DRIVEPOOL9" rather than "Cache Task #1".
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyCollection()] [array] $Caches,
        [Parameter(Mandatory)] [AllowEmptyCollection()] [array] $Volumes,
        [AllowNull()] $Perf = $null,
        [string] $Version = ''
    )

    foreach ($cache in $Caches) {
        $index = 0
        if ($cache.name -match '#(?<n>\d+)') { $index = [int]$Matches['n'] }

        $labels = @(
            $Volumes |
                Where-Object { $null -ne $_.cacheTask -and $_.cacheTask -eq $index -and $_.label } |
                ForEach-Object { if ($_.driveLetter) { "$($_.label) ($($_.driveLetter):)" } else { $_.label } }
        )
        if ($labels.Count -gt 0) { $cache.targetVolumes = $labels }

        if ($null -ne $Perf -and $Perf.recognised) {
            $cache.readHitRate = $Perf.readHitRate
            $cache.writeHitRate = $Perf.writeHitRate
            $cache.readHits = $Perf.readHits
            $cache.readMisses = $Perf.readMisses
            $cache.writeHits = $Perf.writeHits
            $cache.writeMisses = $Perf.writeMisses
        }
    }

    [ordered]@{
        available = ($Caches.Count -gt 0)
        version   = $Version
        reason    = if ($Caches.Count -gt 0) { $null } else { 'rxpcc reported no cache tasks.' }
        caches    = @($Caches)
    }
}

#endregion

#region Performance -----------------------------------------------------------

function ConvertTo-PerformanceSample {
    <#
    .SYNOPSIS
        Shape one PhysicalDisk performance-counter instance into a report sample.
    .DESCRIPTION
        Windows reports "Avg. Disk sec/Read" in seconds; the server works in
        milliseconds. The `_Total` instance is aggregate across every disk and is
        dropped by the caller, since an alert about it would name no drive.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Instance,
        [double] $ReadSeconds = 0,
        [double] $WriteSeconds = 0,
        [double] $QueueLength = 0,
        [double] $ReadBytesPerSec = 0,
        [double] $WriteBytesPerSec = 0,
        [double] $IdlePercent = -1,
        [string] $DeviceId = '',
        [int] $SampleSeconds = 3
    )

    [ordered]@{
        instance         = $Instance
        deviceId         = if ($DeviceId) { $DeviceId } else { ConvertTo-DeviceIdFromInstance $Instance }
        readLatencyMs    = [math]::Round($ReadSeconds * 1000, 3)
        writeLatencyMs   = [math]::Round($WriteSeconds * 1000, 3)
        queueLength      = [math]::Round($QueueLength, 3)
        readBytesPerSec  = [math]::Round($ReadBytesPerSec, 0)
        writeBytesPerSec = [math]::Round($WriteBytesPerSec, 0)
        readsPerSec      = $null
        writesPerSec     = $null
        idlePercent      = if ($IdlePercent -lt 0) { $null } else { [math]::Round($IdlePercent, 2) }
        busyPercent      = if ($IdlePercent -lt 0) { $null } else { [math]::Round(100 - $IdlePercent, 2) }
        sampleSeconds    = $SampleSeconds
    }
}

function ConvertTo-DeviceIdFromInstance {
    <#
    .SYNOPSIS
        Extract the physical drive number from a counter instance name.
    .DESCRIPTION
        Instances look like "3 E: F:" — the leading number is the PhysicalDrive index.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [string] $Instance
    )

    if ($Instance -match '^\s*(?<index>\d+)') {
        return "\\.\PHYSICALDRIVE$($Matches['index'])"
    }
    ''
}

#endregion

#region Helpers ---------------------------------------------------------------

function Get-JsonValue {
    <#
    .SYNOPSIS
        Read a dotted path out of a parsed JSON object, returning $null when absent.
    .DESCRIPTION
        Avoids the pile of null checks that `Set-StrictMode -Version Latest` otherwise
        demands when reading smartctl output, whose shape varies per device.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowNull()] $Object,
        [Parameter(Mandatory)] [string] $Path
    )

    $current = $Object
    foreach ($segment in $Path.Split('.')) {
        if ($null -eq $current) { return $null }

        if ($current -is [System.Collections.IDictionary]) {
            if (-not $current.Contains($segment)) { return $null }
            $current = $current[$segment]
            continue
        }

        $property = $current.PSObject.Properties[$segment]
        if ($null -eq $property) { return $null }
        $current = $property.Value
    }
    $current
}

function ConvertTo-NullableDouble {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [AllowNull()] $Value)

    if ($null -eq $Value) { return $null }
    if ($Value -is [bool]) { return $null }
    $parsed = 0.0
    if ([double]::TryParse([string]$Value, [ref]$parsed)) { return $parsed }
    $null
}

function ConvertTo-NullableBool {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [AllowNull()] $Value)

    if ($null -eq $Value) { return $null }
    if ($Value -is [bool]) { return [bool]$Value }
    $text = [string]$Value
    if ($text -match '^(true|1|yes)$') { return $true }
    if ($text -match '^(false|0|no)$') { return $false }
    $null
}

function ConvertFrom-SizeString {
    <#
    .SYNOPSIS
        Parse a human size such as "12.7 TB" or a raw byte count into bytes.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [AllowEmptyString()] [AllowNull()] $Text)

    if ([string]::IsNullOrWhiteSpace([string]$Text)) { return $null }
    $clean = ([string]$Text).Trim() -replace ',', ''

    if ($clean -match '^(?<n>-?\d+(\.\d+)?)\s*(?<unit>[KMGTPE]?)i?B?$') {
        $number = [double]$Matches['n']
        $unit = $Matches['unit'].ToUpperInvariant()
        $exponent = @{ '' = 0; 'K' = 1; 'M' = 2; 'G' = 3; 'T' = 4; 'P' = 5; 'E' = 6 }[$unit]
        return [long][math]::Round($number * [math]::Pow(1024, $exponent))
    }
    $null
}

#endregion

#region Report assembly -------------------------------------------------------

function New-AgentReport {
    <#
    .SYNOPSIS
        Assemble the report body posted to the server.
    .DESCRIPTION
        Every section is optional: an agent that cannot read SMART, cannot find
        DrivePool or has no PrimoCache still reports what it can, and the server
        records the collector errors so the gap is visible in the interface rather
        than silently absent.
    #>
    [CmdletBinding()]
    param(
        [string] $Hostname = $env:COMPUTERNAME,
        [int] $IntervalSeconds = 900,
        [array] $PhysicalDisks = @(),
        [array] $Volumes = @(),
        [array] $Smart = @(),
        [array] $Pools = @(),
        [array] $Duplication = @(),
        [array] $Performance = @(),
        $PrimoCache = $null,
        [array] $Errors = @()
    )

    [ordered]@{
        protocolVersion = $script:ProtocolVersion
        agentVersion    = $script:AgentVersion
        hostname        = if ($Hostname) { $Hostname } else { 'unknown-host' }
        collectedAt     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        intervalSeconds = $IntervalSeconds
        physicalDisks   = @($PhysicalDisks)
        volumes         = @($Volumes)
        smart           = @($Smart)
        pools           = @($Pools)
        duplication     = @($Duplication)
        performance     = @($Performance)
        primoCache      = $PrimoCache
        errors          = @($Errors)
    }
}

function New-CollectorError {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Collector,
        [Parameter(Mandatory)] [AllowEmptyString()] [string] $Message,
        [string] $Detail = ''
    )

    [ordered]@{
        collector = $Collector
        message   = $Message
        detail    = $Detail
    }
}

#endregion

Export-ModuleMember -Function @(
    'Get-SakuraDriveAgentVersion'
    'Get-DefaultAgentConfig'
    'Merge-AgentConfig'
    'Test-AgentConfig'
    'Get-DeviceKey'
    'ConvertTo-PhysicalDrivePath'
    'ConvertFrom-SmartctlJson'
    'ConvertFrom-StorageReliabilityCounter'
    'ConvertFrom-DpcmdPoolParts'
    'ConvertFrom-DpcmdDuplication'
    'ConvertFrom-DpcmdDuplicationDetail'
    'Resolve-PoolPartVolume'
    'Select-ChangedDuplicationRules'
    'Get-PoolRelativePath'
    'ConvertFrom-RxpccStatus'
    'ConvertFrom-RxpccVolumeList'
    'ConvertFrom-RxpccPerf'
    'Join-PrimoCacheReport'
    'ConvertTo-PerformanceSample'
    'ConvertTo-DeviceIdFromInstance'
    'Get-JsonValue'
    'ConvertTo-NullableDouble'
    'ConvertTo-NullableBool'
    'ConvertFrom-SizeString'
    'New-AgentReport'
    'New-CollectorError'
)
