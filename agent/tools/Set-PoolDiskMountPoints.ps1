<#
.SYNOPSIS
    List every volume on this host and give the ones you choose a folder mount point,
    so WSL2 - and therefore SakuraDrive's container - can see them.

.DESCRIPTION
    Windows has 26 drive letters and this host has more disks than spare ones, which is
    why the DRIVEPOOL volumes have no letter at all. WSL2 only exposes lettered drives
    under /mnt/<letter>, so a letterless volume cannot be bind-mounted into a container
    and cannot be catalogued or hashed.

    A folder mount point fixes that. The volume is attached to an empty directory on a
    lettered NTFS drive, needs no letter of its own, and survives reboots. Windows has
    supported this since 2000; DrivePool does not care either way.

    Run it with no arguments for the interactive picker: it prints every volume, marks
    which are already reachable from WSL and which are not, and touches only what you
    select. Nothing is changed until you confirm, and -WhatIf shows the whole plan
    without writing anything.

    Afterwards it prints the docker-compose lines for the disks it mounted, using the
    same /mnt/parts/<label> convention as the rest of the compose file.

.PARAMETER MountRoot
    Directory the mount points are created under. Must be on an NTFS volume that has a
    drive letter, or WSL will not be able to reach what you mount inside it.

.PARAMETER Label
    Mount these volumes by filesystem label, without prompting.

.PARAMETER All
    Mount every volume that is not already reachable, without prompting.

.PARAMETER ListOnly
    Print the table and stop. Changes nothing, needs no elevation.

.PARAMETER Remove
    Take the mount points under -MountRoot away again instead of creating them. The
    volume and its contents are untouched; only the path you reach it by is removed.

.EXAMPLE
    .\Set-PoolDiskMountPoints.ps1
    The interactive picker.

.EXAMPLE
    .\Set-PoolDiskMountPoints.ps1 -ListOnly
    See what is where, and which volumes WSL cannot currently reach.

.EXAMPLE
    .\Set-PoolDiskMountPoints.ps1 -Label DRIVEPOOL4,DRIVEPOOL9 -WhatIf
    Show exactly what would happen to two named volumes, changing nothing.

.EXAMPLE
    .\Set-PoolDiskMountPoints.ps1 -All
    Mount everything that is not already reachable, under C:\PoolDisks.

.EXAMPLE
    .\Set-PoolDiskMountPoints.ps1 -Label DRIVEPOOL4 -Remove
    Undo one of them.

.NOTES
    Needs an elevated PowerShell (Add-PartitionAccessPath is an administrator operation)
    unless you are only using -ListOnly.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]   $MountRoot = 'C:\PoolDisks',
    [string[]] $Label,
    [switch]   $All,
    [switch]   $ListOnly,
    [switch]   $Remove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------------
# Pure helpers. No Windows cmdlets below this line until the "Host queries" section,
# so the parsing and formatting can be tested on any platform.
# ---------------------------------------------------------------------------------

<#
.SYNOPSIS
    Turn a volume label into a directory name Windows will accept.
#>
function ConvertTo-MountFolderName {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [AllowNull()] [AllowEmptyString()] [string] $Label,
        [string] $Fallback = 'Volume'
    )

    $name = if ($null -eq $Label) { '' } else { $Label.Trim() }

    # Characters Windows forbids in a path component, plus whitespace runs.
    $name = $name -replace '[<>:"/\\|?*]', ''
    $name = $name -replace '\s+', '_'
    # A trailing dot or space makes a directory you cannot delete without \\?\.
    $name = $name.Trim('.', '_')

    if ([string]::IsNullOrWhiteSpace($name)) { return $Fallback }
    if ($name.Length -gt 64) { $name = $name.Substring(0, 64) }
    return $name
}

<#
.SYNOPSIS
    Parse a selection like "1,4,7-9" or "all" into 1-based indices.

.DESCRIPTION
    Written to be forgiving about spacing and separators and unforgiving about
    anything it cannot understand: a typo here would mount the wrong disk.
#>
function Expand-Selection {
    [CmdletBinding()]
    [OutputType([int[]])]
    param(
        [AllowNull()] [AllowEmptyString()] [string] $Selection,
        [Parameter(Mandatory)] [int] $Count
    )

    $text = if ($null -eq $Selection) { '' } else { $Selection.Trim() }
    if ($text -eq '' -or $text -eq 'none' -or $text -eq 'q') { return @() }
    if ($text -eq 'all' -or $text -eq '*') { return [int[]](1..$Count) }

    $indices = [System.Collections.Generic.List[int]]::new()
    foreach ($token in ($text -split '[,;\s]+' | Where-Object { $_ -ne '' })) {
        if ($token -match '^(\d+)\s*-\s*(\d+)$') {
            $from = [int]$Matches[1]
            $to = [int]$Matches[2]
            if ($from -gt $to) { $from, $to = $to, $from }
            foreach ($n in $from..$to) { $indices.Add($n) }
        }
        elseif ($token -match '^\d+$') {
            $indices.Add([int]$token)
        }
        else {
            throw "Could not understand '$token'. Use numbers, ranges like 4-9, 'all', or blank to cancel."
        }
    }

    # @() around the filter on purpose: a single out-of-range 0 is falsy on its own, so
    # `if ($bad)` would wave through exactly the index most likely to be a typo.
    $bad = @($indices | Where-Object { $_ -lt 1 -or $_ -gt $Count } | Select-Object -Unique)
    if ($bad.Count -gt 0) {
        throw "Out of range: $($bad -join ', '). There are $Count volumes listed."
    }

    return [int[]]($indices | Sort-Object -Unique)
}

<#
.SYNOPSIS
    The path WSL2 sees for a Windows path, or $null if WSL cannot reach it.
#>
function ConvertTo-WslPath {
    [CmdletBinding()]
    [OutputType([string])]
    param([AllowNull()] [AllowEmptyString()] [string] $Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    # Only lettered drives appear under /mnt/<letter>; that is the whole problem here.
    if ($Path -notmatch '^([A-Za-z]):\\?(.*)$') { return $null }

    $letter = $Matches[1].ToLowerInvariant()
    $rest = $Matches[2].TrimEnd('\') -replace '\\', '/'
    if ($rest -eq '') { return "/mnt/$letter" }
    return "/mnt/$letter/$rest"
}

<#
.SYNOPSIS
    Human-readable size, for the table only.
#>
function Format-DiskSize {
    [CmdletBinding()]
    [OutputType([string])]
    param([AllowNull()] [System.Nullable[double]] $Bytes)

    if ($null -eq $Bytes -or $Bytes -le 0) { return '' }
    $units = 'B', 'KB', 'MB', 'GB', 'TB', 'PB'
    $value = [double]$Bytes
    $unit = 0
    while ($value -ge 1024 -and $unit -lt ($units.Count - 1)) {
        $value /= 1024
        $unit++
    }
    return ('{0:0.#} {1}' -f $value, $units[$unit])
}

<#
.SYNOPSIS
    Join two Windows path components.

.DESCRIPTION
    Not Join-Path: that resolves the drive qualifier against the current provider, so
    'C:\PoolDisks' throws on a machine with no C: - which is every machine the tests run
    on. These are Windows paths being *composed*, not paths being resolved.
#>
function Join-WindowsPath {
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)] [string] $Parent,
        [Parameter(Mandatory)] [string] $Child
    )
    return ($Parent.TrimEnd('\') + '\' + $Child)
}

<#
.SYNOPSIS
    Shape one volume plus its partition into the row the picker works with.

.DESCRIPTION
    Takes the objects rather than fetching them so the classification - which is the
    part that decides what gets mounted - can be tested without a Windows host.
#>
function ConvertTo-MountCandidate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Volume,
        [AllowNull()] $Partition,
        [string] $MountRoot = 'C:\PoolDisks',
        [int] $Index = 0
    )

    $letter = $null
    if ($Volume.PSObject.Properties['DriveLetter'] -and $Volume.DriveLetter) {
        $letter = ([string]$Volume.DriveLetter).Trim(':', ' ')
        if ($letter -eq '') { $letter = $null }
    }

    $accessPaths = @()
    if ($Partition -and $Partition.PSObject.Properties['AccessPaths'] -and $Partition.AccessPaths) {
        $accessPaths = @($Partition.AccessPaths)
    }

    # A folder mount point is any access path that is not the volume GUID path and not
    # a bare drive root - that is, somewhere a person could actually cd into.
    $folders = @(
        $accessPaths | Where-Object {
            $_ -and $_ -notmatch '^\\\\\?\\Volume\{' -and $_ -notmatch '^[A-Za-z]:\\?$'
        } | ForEach-Object { $_.TrimEnd('\') }
    )

    $isSystem = $false
    foreach ($flag in 'IsSystem', 'IsBoot') {
        if ($Partition -and $Partition.PSObject.Properties[$flag] -and $Partition.$flag) { $isSystem = $true }
    }

    # Partitions Windows put there for itself. They look exactly like an unmounted data
    # disk -- small, letterless, sometimes unlabelled -- so without this the recovery and
    # reserved partitions are offered alongside the pool disks, and -All would mount them.
    # Nothing good comes of giving WinRE a path into a container.
    $isReserved = $false
    if ($Partition) {
        if ($Partition.PSObject.Properties['IsHidden'] -and $Partition.IsHidden) { $isReserved = $true }
        if ($Partition.PSObject.Properties['Type'] -and
            @('System', 'Reserved', 'Recovery') -contains [string]$Partition.Type) { $isReserved = $true }
        if ($Partition.PSObject.Properties['GptType'] -and $Partition.GptType) {
            $gpt = ([string]$Partition.GptType).Trim('{', '}').ToLowerInvariant()
            $reservedTypes = @(
                'c12a7328-f81f-11d2-ba4b-00a0c93ec93b'  # EFI system partition
                'e3c9e316-0b5c-4db8-817d-f92df00215ae'  # Microsoft reserved
                'de94bba4-06d1-4d40-a16a-bfd50179d6ac'  # Windows recovery (WinRE)
            )
            if ($reservedTypes -contains $gpt) { $isReserved = $true }
        }
    }

    $status =
    if ($isSystem) { 'system' }
    elseif ($isReserved) { 'reserved' }
    elseif ($letter) { 'letter' }
    elseif ($folders.Count -gt 0) { 'folder' }
    else { 'unmounted' }

    # Where WSL can already reach it, if anywhere.
    $wslPath = $null
    if ($letter) { $wslPath = ConvertTo-WslPath -Path "$($letter):\" }
    if (-not $wslPath) {
        foreach ($folder in $folders) {
            $candidate = ConvertTo-WslPath -Path $folder
            if ($candidate) { $wslPath = $candidate; break }
        }
    }

    $label = if ($Volume.PSObject.Properties['FileSystemLabel']) { $Volume.FileSystemLabel } else { $null }
    $diskNumber = if ($Partition -and $Partition.PSObject.Properties['DiskNumber']) { $Partition.DiskNumber } else { $null }
    $partitionNumber = if ($Partition -and $Partition.PSObject.Properties['PartitionNumber']) { $Partition.PartitionNumber } else { $null }

    $fallback = if ($null -ne $diskNumber) { "Disk$diskNumber-Part$partitionNumber" } else { 'Volume' }
    $folderName = ConvertTo-MountFolderName -Label $label -Fallback $fallback

    [pscustomobject]@{
        Index           = $Index
        Label           = $label
        Letter          = $letter
        FileSystem      = if ($Volume.PSObject.Properties['FileSystem']) { $Volume.FileSystem } else { $null }
        SizeBytes       = if ($Volume.PSObject.Properties['Size']) { $Volume.Size } else { $null }
        FreeBytes       = if ($Volume.PSObject.Properties['SizeRemaining']) { $Volume.SizeRemaining } else { $null }
        VolumePath      = if ($Volume.PSObject.Properties['Path']) { $Volume.Path } else { $null }
        DiskNumber      = $diskNumber
        PartitionNumber = $partitionNumber
        MountFolders    = $folders
        Status          = $status
        WslPath         = $wslPath
        Reachable       = [bool]$wslPath
        ProposedPath    = (Join-WindowsPath -Parent $MountRoot -Child $folderName)
    }
}

<#
.SYNOPSIS
    Render the candidate table as lines of text.
#>
function Format-CandidateTable {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)] [AllowEmptyCollection()] [object[]] $Candidates)

    $lines = [System.Collections.Generic.List[string]]::new()
    $header = '{0,3}  {1,-16} {2,-4} {3,-6} {4,-8} {5,-9} {6}' -f `
        '#', 'Label', 'Ltr', 'FS', 'Size', 'Status', 'Reachable from WSL as'
    $lines.Add($header)
    $lines.Add('-' * $header.Length)

    foreach ($candidate in $Candidates) {
        $label = if ($candidate.Label) { $candidate.Label } else { '(no label)' }
        $letter = if ($candidate.Letter) { "$($candidate.Letter):" } else { '-' }
        $fs = if ($candidate.FileSystem) { $candidate.FileSystem } else { '?' }
        $wsl = if ($candidate.WslPath) { $candidate.WslPath } else { 'NOT VISIBLE' }
        $cells = @(
            $candidate.Index, $label, $letter, $fs,
            (Format-DiskSize -Bytes $candidate.SizeBytes), $candidate.Status, $wsl
        )
        $lines.Add('{0,3}  {1,-16} {2,-4} {3,-6} {4,-8} {5,-9} {6}' -f $cells)
    }
    return $lines.ToArray()
}

<#
.SYNOPSIS
    The compose lines for the disks that were mounted, in this project's convention.
#>
function Format-ComposeLines {
    [CmdletBinding()]
    [OutputType([string[]])]
    param([Parameter(Mandatory)] [AllowEmptyCollection()] [object[]] $Candidates)

    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in $Candidates) {
        if (-not $candidate.WslPath) { continue }
        $name = (ConvertTo-MountFolderName -Label $candidate.Label -Fallback "disk$($candidate.DiskNumber)").ToLowerInvariant()
        # Read-only on purpose: SakuraDrive never writes to your data.
        $lines.Add("      - $($candidate.WslPath):/mnt/parts/$($name):ro")
    }
    return $lines.ToArray()
}

# ---------------------------------------------------------------------------------
# Host queries and the operations that change something.
# ---------------------------------------------------------------------------------

function Assert-Administrator {
    [CmdletBinding()]
    param()
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Adding a mount point needs an elevated PowerShell. Re-run this from "Windows PowerShell (Admin)", or use -ListOnly to look without changing anything.'
    }
}

<#
.SYNOPSIS
    Every fixed volume on this host, as picker rows.
#>
function Get-MountCandidate {
    [CmdletBinding()]
    param([string] $MountRoot = 'C:\PoolDisks')

    $partitions = @(Get-Partition -ErrorAction SilentlyContinue)
    $volumes = @(Get-Volume -ErrorAction Stop |
        Where-Object { $_.DriveType -eq 'Fixed' } |
        Sort-Object -Property @{ Expression = { [string]$_.FileSystemLabel } }, @{ Expression = { [string]$_.DriveLetter } })

    $index = 0
    foreach ($volume in $volumes) {
        # Matching on the volume GUID path is the only lookup that works for a volume
        # with no drive letter, which is exactly the case this script exists for.
        $partition = $partitions | Where-Object {
            $_.AccessPaths -and ($_.AccessPaths -contains $volume.Path)
        } | Select-Object -First 1

        $index++
        ConvertTo-MountCandidate -Volume $volume -Partition $partition -MountRoot $MountRoot -Index $index
    }
}

<#
.SYNOPSIS
    Attach one volume to an empty directory.
#>
function Add-VolumeMountPoint {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] $Candidate,
        [Parameter(Mandatory)] [string] $Path
    )

    if ($Candidate.Status -eq 'system') {
        throw "$($Candidate.Label) is the system or boot volume. Refusing to touch it."
    }
    if ($Candidate.Status -eq 'reserved') {
        throw "$($Candidate.Label) is a Windows recovery or reserved partition, not a data disk. Refusing to touch it."
    }
    if ($null -eq $Candidate.DiskNumber -or $null -eq $Candidate.PartitionNumber) {
        throw "No partition found for $($Candidate.Label) ($($Candidate.VolumePath)). Mount it from Disk Management instead."
    }
    if ($Candidate.MountFolders -contains $Path.TrimEnd('\')) {
        Write-Host "  already mounted at $Path" -ForegroundColor DarkGray
        return $false
    }

    # Windows requires the target directory to exist and be empty.
    if (Test-Path -LiteralPath $Path) {
        $existing = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue)
        if ($existing.Count -gt 0) {
            throw "$Path is not empty. A mount point has to be an empty directory - pick another name or clear it first."
        }
    }
    elseif ($PSCmdlet.ShouldProcess($Path, 'Create empty directory')) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }

    if ($PSCmdlet.ShouldProcess(
            "$($Candidate.Label) (disk $($Candidate.DiskNumber), partition $($Candidate.PartitionNumber))",
            "Mount at $Path")) {
        Add-PartitionAccessPath -DiskNumber $Candidate.DiskNumber `
            -PartitionNumber $Candidate.PartitionNumber -AccessPath $Path -ErrorAction Stop

        # Verify rather than assume: a mount point that silently did not take would be
        # discovered much later, as an empty catalog root.
        $check = Get-Partition -DiskNumber $Candidate.DiskNumber -PartitionNumber $Candidate.PartitionNumber
        if ($check.AccessPaths -notcontains ($Path.TrimEnd('\') + '\') -and $check.AccessPaths -notcontains $Path) {
            throw "Windows accepted the mount for $($Candidate.Label) but $Path is not among its access paths."
        }
        return $true
    }
    return $false
}

<#
.SYNOPSIS
    Detach a mount point. The volume and its contents are untouched.
#>
function Remove-VolumeMountPoint {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)] $Candidate,
        [Parameter(Mandatory)] [string] $Path
    )

    $normalised = $Path.TrimEnd('\')
    if ($Candidate.MountFolders -notcontains $normalised) {
        Write-Host "  nothing mounted at $Path" -ForegroundColor DarkGray
        return $false
    }
    if ($PSCmdlet.ShouldProcess("$($Candidate.Label) at $Path", 'Remove mount point')) {
        Remove-PartitionAccessPath -DiskNumber $Candidate.DiskNumber `
            -PartitionNumber $Candidate.PartitionNumber -AccessPath $Path -ErrorAction Stop
        Remove-Item -LiteralPath $normalised -Force -ErrorAction SilentlyContinue
        return $true
    }
    return $false
}

function Invoke-Main {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [string]   $MountRoot = 'C:\PoolDisks',
        [string[]] $Label,
        [switch]   $All,
        [switch]   $ListOnly,
        [switch]   $Remove
    )

    if (-not $ListOnly) { Assert-Administrator }

    $candidates = @(Get-MountCandidate -MountRoot $MountRoot)
    if ($candidates.Count -eq 0) {
        Write-Warning 'No fixed volumes found.'
        return
    }

    Write-Host ''
    Format-CandidateTable -Candidates $candidates | ForEach-Object { Write-Host $_ }
    Write-Host ''

    # Candidates: unreachable from WSL, and something a person would actually catalogue.
    $invisible = @(
        $candidates | Where-Object { -not $_.Reachable -and $_.Status -ne 'system' -and $_.Status -ne 'reserved' }
    )
    $skipped = @($candidates | Where-Object { $_.Status -eq 'reserved' })
    # Say what the number counts. Rows marked NOT VISIBLE include the system and reserved
    # partitions, which are not candidates, so "N are invisible" would not add up.
    $unreachable = @($candidates | Where-Object { -not $_.Reachable })
    Write-Host ("{0} data disk(s) here cannot be catalogued: WSL2 does not see them." -f $invisible.Count)
    Write-Host ("{0} of {1} volumes are not reachable from WSL2 at all." -f $unreachable.Count, $candidates.Count) -ForegroundColor DarkGray
    if ($skipped.Count -gt 0) {
        Write-Host ("{0} Windows recovery or reserved partition(s) are listed but excluded: {1}" -f
            $skipped.Count, (($skipped | ForEach-Object { "#$($_.Index)" }) -join ', ')) -ForegroundColor DarkGray
    }
    if ($ListOnly) { return }

    # ---- choose ----
    $chosen = @()
    if ($Label) {
        foreach ($wanted in $Label) {
            $match = $candidates | Where-Object { $_.Label -eq $wanted }
            if (-not $match) { throw "No volume labelled '$wanted'. Run with -ListOnly to see the labels." }
            $chosen += $match
        }
    }
    elseif ($All) {
        $chosen = if ($Remove) { @($candidates | Where-Object { $_.MountFolders.Count -gt 0 }) } else { $invisible }
    }
    else {
        $verb = if ($Remove) { 'unmount' } else { 'mount' }
        $suggestion = ($invisible | ForEach-Object { $_.Index }) -join ','
        Write-Host ''
        # ${verb} braced on purpose: PowerShell allows '?' in a variable name, so "$verb?"
        # looks up a variable called "verb?" and fails under StrictMode.
        Write-Host "Which volumes should I ${verb}? Numbers, ranges (4-9), 'all', or blank to cancel."
        if (-not $Remove -and $suggestion) { Write-Host "The ones WSL cannot see are: $suggestion" -ForegroundColor Cyan }
        $answer = Read-Host 'Selection'
        $indices = @(Expand-Selection -Selection $answer -Count $candidates.Count)
        if ($indices.Count -eq 0) {
            Write-Host 'Nothing selected. No changes made.'
            return
        }
        $chosen = @($candidates | Where-Object { $indices -contains $_.Index })
    }

    if ($chosen.Count -eq 0) {
        Write-Host 'Nothing to do.'
        return
    }

    # ---- confirm the plan ----
    Write-Host ''
    if ($Remove) { Write-Host 'Plan - remove these mount points:' }
    else { Write-Host 'Plan - mount these volumes:' }
    foreach ($candidate in $chosen) {
        $target = if ($Remove -and $candidate.MountFolders.Count -gt 0) { $candidate.MountFolders[0] } else { $candidate.ProposedPath }
        $shown = if ($candidate.Label) { $candidate.Label } else { '(no label)' }
        Write-Host ("  {0,-16} -> {1}" -f $shown, $target)
    }
    Write-Host ''

    $done = [System.Collections.Generic.List[object]]::new()
    foreach ($candidate in $chosen) {
        $name = if ($candidate.Label) { $candidate.Label } else { "disk $($candidate.DiskNumber)" }
        Write-Host "$name..."
        try {
            if ($Remove) {
                $target = if ($candidate.MountFolders.Count -gt 0) { $candidate.MountFolders[0] } else { $candidate.ProposedPath }
                if (Remove-VolumeMountPoint -Candidate $candidate -Path $target) {
                    Write-Host "  removed $target" -ForegroundColor Green
                }
            }
            else {
                if (Add-VolumeMountPoint -Candidate $candidate -Path $candidate.ProposedPath) {
                    Write-Host "  mounted at $($candidate.ProposedPath)" -ForegroundColor Green
                    $done.Add((ConvertTo-MountCandidate -Volume ([pscustomobject]@{
                                    FileSystemLabel = $candidate.Label
                                    FileSystem      = $candidate.FileSystem
                                    Size            = $candidate.SizeBytes
                                    SizeRemaining   = $candidate.FreeBytes
                                    Path            = $candidate.VolumePath
                                    DriveLetter     = $null
                                }) -Partition ([pscustomobject]@{
                                    DiskNumber      = $candidate.DiskNumber
                                    PartitionNumber = $candidate.PartitionNumber
                                    AccessPaths     = @($candidate.ProposedPath)
                                }) -MountRoot $MountRoot -Index $candidate.Index))
                }
            }
        }
        catch {
            Write-Host "  FAILED: $($_.Exception.Message)" -ForegroundColor Red
        }
    }

    if ($Remove -or $done.Count -eq 0) { return }

    Write-Host ''
    Write-Host 'Next: check WSL can see them.' -ForegroundColor Cyan
    Write-Host '  A folder mount point is a reparse point, so WSL2 follows it like any other'
    Write-Host '  directory - but confirm it rather than trusting it. From WSL:'
    Write-Host ''
    foreach ($candidate in $done) {
        Write-Host "    ls '$($candidate.WslPath)'"
    }
    Write-Host ''
    Write-Host '  Empty output means drvfs did not follow the mount point. In that case give the'
    Write-Host '  volume a drive letter instead (Get-Volume | Set-Partition -NewDriveLetter), which'
    Write-Host '  always works - you have enough spare letters for the pool as it stands today.'
    Write-Host ''
    Write-Host 'Then add these to docker/docker-compose.yml under volumes:' -ForegroundColor Cyan
    Write-Host ''
    Format-ComposeLines -Candidates $done | ForEach-Object { Write-Host $_ }
    Write-Host ''
    Write-Host 'and add one catalog root per disk in Settings -> Catalog roots, kind "poolpart",'
    Write-Host 'with the drive label set so a failed disk can be identified by its caddy.'
}

# Dot-sourcing (the tests do this) leaves the functions defined and runs nothing.
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-Main -MountRoot $MountRoot -Label $Label -All:$All -ListOnly:$ListOnly -Remove:$Remove
}
