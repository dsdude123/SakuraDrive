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
        dpcmd prints a banner, then one indented block per pool part. The format has
        varied across DrivePool releases, so this reads it line by line and keeps
        whatever it recognises rather than insisting on an exact layout: a part is
        identified by its PoolPart folder, and the surrounding lines supply the drive
        letter, label and sizes when they are present.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [AllowNull()] [string[]] $Lines
    )

    $parts = New-Object System.Collections.Generic.List[object]
    if ($null -eq $Lines) { return , $parts.ToArray() }

    $current = $null
    $flush = {
        if ($null -ne $current -and $current.partId) { $parts.Add($current) }
    }

    foreach ($rawLine in $Lines) {
        if ($null -eq $rawLine) { continue }
        $line = $rawLine.Trim()
        if (-not $line) { continue }

        # A line containing a PoolPart folder starts a new part.
        if ($line -match '(?<letter>[A-Za-z]):\\(?<part>PoolPart\.[0-9a-fA-F-]+)') {
            & $flush
            $current = [ordered]@{
                partId          = $Matches['part']
                name            = ''
                volumeId        = ''
                volumeLabel     = ''
                driveLetter     = $Matches['letter'].ToUpperInvariant()
                path            = "$($Matches['letter'].ToUpperInvariant()):\$($Matches['part'])"
                sizeBytes       = $null
                freeBytes       = $null
                usedBytes       = $null
                physicalDiskId  = $null
                missing         = $false
                readOnly        = $false
            }
            continue
        }

        if ($null -eq $current) { continue }

        if ($line -match '^(Name|Label)\s*[:=]\s*(?<value>.+)$') {
            $current.name = $Matches['value'].Trim()
            if (-not $current.volumeLabel) { $current.volumeLabel = $current.name }
            continue
        }
        if ($line -match '^(Total|Size|Capacity)\s*[:=]\s*(?<value>.+)$') {
            $current.sizeBytes = ConvertFrom-SizeString $Matches['value']
            continue
        }
        if ($line -match '^(Free|Available)\s*[:=]\s*(?<value>.+)$') {
            $current.freeBytes = ConvertFrom-SizeString $Matches['value']
            continue
        }
        if ($line -match '^(Used)\s*[:=]\s*(?<value>.+)$') {
            $current.usedBytes = ConvertFrom-SizeString $Matches['value']
            continue
        }
        if ($line -match 'missing|not\s+connected|unavailable') {
            $current.missing = $true
            continue
        }
        if ($line -match 'read[-\s]?only') {
            $current.readOnly = $true
            continue
        }
    }

    & $flush
    , $parts.ToArray()
}

function ConvertFrom-DpcmdDuplication {
    <#
    .SYNOPSIS
        Extract the duplication count from `dpcmd get-duplication <path>` output.
    .OUTPUTS
        The integer level, or $null when the output does not contain one.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [AllowEmptyString()] [AllowNull()] [string[]] $Lines
    )

    if ($null -eq $Lines) { return $null }

    foreach ($rawLine in $Lines) {
        if ($null -eq $rawLine) { continue }
        $line = $rawLine.Trim()
        if ($line -match 'duplicat\w*\s*(count|level)?\s*[:=]\s*(?<level>\d+)') {
            return [int]$Matches['level']
        }
        # Some builds print "File duplication is 2x" or simply "2x".
        if ($line -match '\b(?<level>\d+)\s*x\b') {
            return [int]$Matches['level']
        }
    }
    $null
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
    'Select-ChangedDuplicationRules'
    'Get-PoolRelativePath'
    'ConvertTo-PerformanceSample'
    'ConvertTo-DeviceIdFromInstance'
    'Get-JsonValue'
    'ConvertTo-NullableDouble'
    'ConvertTo-NullableBool'
    'ConvertFrom-SizeString'
    'New-AgentReport'
    'New-CollectorError'
)
