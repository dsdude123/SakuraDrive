#Requires -Modules Pester

# Set-PoolDiskMountPoints.ps1 exists because WSL2 only exposes lettered drives, and this
# host has more pool disks than spare letters. The parts that decide *which* volume gets
# mounted *where* are pure functions so they can be tested here, on any platform; only
# the Get-Partition / Add-PartitionAccessPath calls need Windows.
BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'tools' 'Set-PoolDiskMountPoints.ps1')
}

Describe 'Folder names from volume labels' {
    It 'uses the label as-is when it is already a valid name' {
        ConvertTo-MountFolderName -Label 'DRIVEPOOL4' | Should -Be 'DRIVEPOOL4'
    }

    It 'strips characters Windows forbids in a path' {
        ConvertTo-MountFolderName -Label 'Pool:1/2*3' | Should -Be 'Pool123'
    }

    It 'replaces whitespace so the path needs no quoting' {
        ConvertTo-MountFolderName -Label 'Big  Media Disk' | Should -Be 'Big_Media_Disk'
    }

    It 'trims trailing dots, which make a directory you cannot delete' {
        ConvertTo-MountFolderName -Label 'Archive...' | Should -Be 'Archive'
    }

    It 'falls back when the volume has no label at all' {
        ConvertTo-MountFolderName -Label '' -Fallback 'Disk7-Part2' | Should -Be 'Disk7-Part2'
        ConvertTo-MountFolderName -Label $null -Fallback 'Disk7-Part2' | Should -Be 'Disk7-Part2'
        ConvertTo-MountFolderName -Label '   ' -Fallback 'Disk7-Part2' | Should -Be 'Disk7-Part2'
    }

    It 'falls back when the label was made of nothing but forbidden characters' {
        ConvertTo-MountFolderName -Label '***' -Fallback 'Disk1-Part1' | Should -Be 'Disk1-Part1'
    }

    It 'bounds the length' {
        (ConvertTo-MountFolderName -Label ('x' * 200)).Length | Should -Be 64
    }
}

Describe 'Selection parsing' {
    It 'reads a list of numbers' {
        Expand-Selection -Selection '1,3,5' -Count 10 | Should -Be @(1, 3, 5)
    }

    It 'reads ranges' {
        Expand-Selection -Selection '4-7' -Count 10 | Should -Be @(4, 5, 6, 7)
    }

    It 'reads numbers and ranges together, in any order, with any spacing' {
        Expand-Selection -Selection ' 9 , 2-4 ;1 ' -Count 10 | Should -Be @(1, 2, 3, 4, 9)
    }

    It 'accepts a backwards range rather than silently selecting nothing' {
        Expand-Selection -Selection '7-4' -Count 10 | Should -Be @(4, 5, 6, 7)
    }

    It 'de-duplicates overlapping selections' {
        Expand-Selection -Selection '1-3,2,3' -Count 10 | Should -Be @(1, 2, 3)
    }

    It 'understands all' {
        Expand-Selection -Selection 'all' -Count 3 | Should -Be @(1, 2, 3)
        Expand-Selection -Selection '*' -Count 3 | Should -Be @(1, 2, 3)
    }

    It 'treats blank as cancel' {
        @(Expand-Selection -Selection '' -Count 5).Count | Should -Be 0
        @(Expand-Selection -Selection '  ' -Count 5).Count | Should -Be 0
        @(Expand-Selection -Selection 'none' -Count 5).Count | Should -Be 0
    }

    # A typo here would attach the wrong disk, so it must fail rather than guess.
    It 'refuses an index past the end of the list' {
        { Expand-Selection -Selection '11' -Count 10 } | Should -Throw '*Out of range*'
    }

    It 'refuses a range that runs past the end' {
        { Expand-Selection -Selection '8-12' -Count 10 } | Should -Throw '*Out of range*'
    }

    It 'refuses zero' {
        { Expand-Selection -Selection '0' -Count 10 } | Should -Throw '*Out of range*'
    }

    It 'refuses anything it cannot parse' {
        { Expand-Selection -Selection 'DRIVEPOOL4' -Count 10 } | Should -Throw '*Could not understand*'
    }
}

Describe 'Windows paths as WSL sees them' {
    It 'maps a lettered drive root' {
        ConvertTo-WslPath -Path 'C:\' | Should -Be '/mnt/c'
        ConvertTo-WslPath -Path 'D:' | Should -Be '/mnt/d'
    }

    It 'maps a folder mount point' {
        ConvertTo-WslPath -Path 'C:\PoolDisks\DRIVEPOOL4' | Should -Be '/mnt/c/PoolDisks/DRIVEPOOL4'
    }

    It 'lower-cases the drive letter, because /mnt/C does not exist' {
        ConvertTo-WslPath -Path 'M:\Tier2' | Should -Be '/mnt/m/Tier2'
    }

    It 'ignores a trailing separator' {
        ConvertTo-WslPath -Path 'C:\PoolDisks\DRIVEPOOL4\' | Should -Be '/mnt/c/PoolDisks/DRIVEPOOL4'
    }

    # The volume GUID path is exactly what WSL cannot reach - the reason for this script.
    It 'returns nothing for a volume GUID path' {
        ConvertTo-WslPath -Path '\\?\Volume{9f3a-1}\' | Should -BeNullOrEmpty
    }

    It 'returns nothing for a UNC path or for nothing' {
        ConvertTo-WslPath -Path '\\tokyo-3\share' | Should -BeNullOrEmpty
        ConvertTo-WslPath -Path '' | Should -BeNullOrEmpty
    }
}

Describe 'Classifying a volume' {
    BeforeAll {
        function New-Volume {
            param($Label, $Letter, $Size = 14000519643136, $Path = '\\?\Volume{aaaa}\')
            [pscustomobject]@{
                FileSystemLabel = $Label
                DriveLetter     = $Letter
                FileSystem      = 'NTFS'
                Size            = $Size
                SizeRemaining   = 1000000000
                Path            = $Path
            }
        }
        function New-Partition2 {
            param($AccessPaths = @(), $Disk = 4, $Number = 2, $IsSystem = $false, $IsBoot = $false)
            [pscustomobject]@{
                DiskNumber      = $Disk
                PartitionNumber = $Number
                AccessPaths     = $AccessPaths
                IsSystem        = $IsSystem
                IsBoot          = $IsBoot
            }
        }
    }

    It 'marks a letterless, unmounted volume as invisible to WSL' {
        $row = ConvertTo-MountCandidate `
            -Volume (New-Volume -Label 'DRIVEPOOL4' -Letter $null) `
            -Partition (New-Partition2 -AccessPaths @('\\?\Volume{aaaa}\'))

        $row.Status | Should -Be 'unmounted'
        $row.Reachable | Should -BeFalse
        $row.WslPath | Should -BeNullOrEmpty
        $row.ProposedPath | Should -Be 'C:\PoolDisks\DRIVEPOOL4'
    }

    It 'marks a lettered volume as already reachable' {
        $row = ConvertTo-MountCandidate `
            -Volume (New-Volume -Label 'SSDPOOl1' -Letter 'M') `
            -Partition (New-Partition2 -AccessPaths @('M:\', '\\?\Volume{aaaa}\'))

        $row.Status | Should -Be 'letter'
        $row.Reachable | Should -BeTrue
        $row.WslPath | Should -Be '/mnt/m'
    }

    It 'recognises a volume that already has a folder mount point' {
        $row = ConvertTo-MountCandidate `
            -Volume (New-Volume -Label 'DRIVEPOOL9' -Letter $null) `
            -Partition (New-Partition2 -AccessPaths @('C:\PoolDisks\DRIVEPOOL9\', '\\?\Volume{aaaa}\'))

        $row.Status | Should -Be 'folder'
        $row.MountFolders | Should -Be @('C:\PoolDisks\DRIVEPOOL9')
        $row.WslPath | Should -Be '/mnt/c/PoolDisks/DRIVEPOOL9'
    }

    # Mounting the boot volume somewhere else is never what anyone meant.
    It 'flags the system volume so it is never touched' {
        $row = ConvertTo-MountCandidate `
            -Volume (New-Volume -Label '' -Letter $null) `
            -Partition (New-Partition2 -AccessPaths @() -IsSystem $true)
        $row.Status | Should -Be 'system'
    }

    # From tokyo-3: an 825 MB unlabelled NTFS partition and a 450 MB one called
    # "Recovery" sat in the listing looking exactly like small unmounted data disks.
    # Neither IsSystem nor IsBoot is set on them, so without this they would have been
    # in the suggested selection and in -All.
    It 'recognises a recovery partition by its GPT type' {
        $row = ConvertTo-MountCandidate `
            -Volume (New-Volume -Label '' -Letter $null -Size 865075200) `
            -Partition (New-Partition2 -Disk 0 -Number 4)
        $row.Status | Should -Be 'unmounted'

        $recovery = New-Partition2 -Disk 0 -Number 4
        $recovery | Add-Member -NotePropertyName GptType -NotePropertyValue '{de94bba4-06d1-4d40-a16a-bfd50179d6ac}'
        $row = ConvertTo-MountCandidate -Volume (New-Volume -Label '' -Letter $null) -Partition $recovery
        $row.Status | Should -Be 'reserved'
    }

    It 'recognises the EFI system partition and the Microsoft reserved partition' {
        foreach ($guid in 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b', 'e3c9e316-0b5c-4db8-817d-f92df00215ae') {
            $partition = New-Partition2 -Disk 0 -Number 1
            $partition | Add-Member -NotePropertyName GptType -NotePropertyValue "{$guid}"
            (ConvertTo-MountCandidate -Volume (New-Volume -Label '' -Letter $null) -Partition $partition).Status |
                Should -Be 'reserved'
        }
    }

    It 'recognises one by its friendly partition type, for the unlabelled case' {
        $partition = New-Partition2 -Disk 0 -Number 4
        $partition | Add-Member -NotePropertyName Type -NotePropertyValue 'Recovery'
        (ConvertTo-MountCandidate -Volume (New-Volume -Label '' -Letter $null) -Partition $partition).Status |
            Should -Be 'reserved'
    }

    It 'recognises a hidden partition' {
        $partition = New-Partition2 -Disk 0 -Number 4
        $partition | Add-Member -NotePropertyName IsHidden -NotePropertyValue $true
        (ConvertTo-MountCandidate -Volume (New-Volume -Label 'Recovery' -Letter $null) -Partition $partition).Status |
            Should -Be 'reserved'
    }

    # A pool disk can be small -- DRIVEPOOL16 is 931 GB where its neighbours are 18 TB --
    # so size must never be part of this decision.
    It 'leaves a small but ordinary data disk alone' {
        $row = ConvertTo-MountCandidate `
            -Volume (New-Volume -Label 'DRIVEPOOL16' -Letter $null -Size 1000203804160) `
            -Partition (New-Partition2 -Disk 9 -Number 2)
        $row.Status | Should -Be 'unmounted'
    }

    It 'names an unlabelled volume after its disk and partition' {
        $row = ConvertTo-MountCandidate `
            -Volume (New-Volume -Label '' -Letter $null) `
            -Partition (New-Partition2 -Disk 7 -Number 3)
        $row.ProposedPath | Should -Be 'C:\PoolDisks\Disk7-Part3'
    }

    It 'copes with a volume that has no partition at all' {
        $row = ConvertTo-MountCandidate -Volume (New-Volume -Label 'ORPHAN' -Letter $null) -Partition $null
        $row.DiskNumber | Should -BeNullOrEmpty
        $row.Status | Should -Be 'unmounted'
    }

    It 'honours a different mount root' {
        $row = ConvertTo-MountCandidate `
            -Volume (New-Volume -Label 'DRIVEPOOL4' -Letter $null) `
            -Partition (New-Partition2) -MountRoot 'D:\Disks'
        $row.ProposedPath | Should -Be 'D:\Disks\DRIVEPOOL4'
    }
}

Describe 'What it refuses to touch' {
    It 'refuses the system volume and a reserved partition alike' {
        foreach ($status in 'system', 'reserved') {
            $candidate = [pscustomobject]@{
                Label = 'X'; Status = $status; DiskNumber = 0; PartitionNumber = 1
                MountFolders = @(); VolumePath = '\\?\Volume{a}\'
            }
            { Add-VolumeMountPoint -Candidate $candidate -Path 'C:\PoolDisks\X' } |
                Should -Throw '*Refusing to touch it*'
        }
    }
}

Describe 'Output for the compose file' {
    It 'writes one read-only bind mount per disk, in this project convention' {
        $rows = @(
            ConvertTo-MountCandidate -Volume ([pscustomobject]@{
                    FileSystemLabel = 'DRIVEPOOL4'; DriveLetter = $null; FileSystem = 'NTFS'
                    Size            = 1; SizeRemaining = 1; Path = '\\?\Volume{a}\'
                }) -Partition ([pscustomobject]@{
                    DiskNumber = 4; PartitionNumber = 2; AccessPaths = @('C:\PoolDisks\DRIVEPOOL4')
                })
        )
        Format-ComposeLines -Candidates $rows |
            Should -Be @('      - /mnt/c/PoolDisks/DRIVEPOOL4:/mnt/parts/drivepool4:ro')
    }

    It 'skips a volume WSL still cannot see, rather than emitting a broken mount' {
        $rows = @(
            ConvertTo-MountCandidate -Volume ([pscustomobject]@{
                    FileSystemLabel = 'DRIVEPOOL9'; DriveLetter = $null; FileSystem = 'NTFS'
                    Size            = 1; SizeRemaining = 1; Path = '\\?\Volume{b}\'
                }) -Partition ([pscustomobject]@{
                    DiskNumber = 9; PartitionNumber = 2; AccessPaths = @('\\?\Volume{b}\')
                })
        )
        @(Format-ComposeLines -Candidates $rows).Count | Should -Be 0
    }
}

Describe 'The table' {
    It 'has a header and one line per volume' {
        $rows = @(
            ConvertTo-MountCandidate -Index 1 -Volume ([pscustomobject]@{
                    FileSystemLabel = 'DRIVEPOOL4'; DriveLetter = $null; FileSystem = 'NTFS'
                    Size            = 14000519643136; SizeRemaining = 1; Path = '\\?\Volume{a}\'
                }) -Partition ([pscustomobject]@{ DiskNumber = 4; PartitionNumber = 2; AccessPaths = @() })
        )
        $lines = Format-CandidateTable -Candidates $rows
        $lines.Count | Should -Be 3
        $lines[0] | Should -Match 'Label'
        $lines[2] | Should -Match 'DRIVEPOOL4'
        $lines[2] | Should -Match 'NOT VISIBLE'
        $lines[2] | Should -Match '12.7 TB'
    }

    It 'renders an empty list without failing' {
        @(Format-CandidateTable -Candidates @()).Count | Should -Be 2
    }
}

Describe 'Sizes' {
    It 'scales to a sensible unit' {
        Format-DiskSize -Bytes 14000519643136 | Should -Be '12.7 TB'
        Format-DiskSize -Bytes 1024 | Should -Be '1 KB'
    }

    It 'renders nothing for an unknown size' {
        Format-DiskSize -Bytes $null | Should -Be ''
        Format-DiskSize -Bytes 0 | Should -Be ''
    }
}

Describe 'Enumerating the host' {
    # Get-Volume and Get-Partition are Windows-only, so they are mocked here. What is
    # being tested is the join between them: a letterless volume can only be matched to
    # its partition through the volume GUID path, which is the whole difficulty.
    BeforeAll {
        function Get-Volume { param($FileSystemLabel) }
        function Get-Partition { param($DiskNumber, $PartitionNumber, $Volume) }

        Mock Get-Volume {
            @(
                [pscustomobject]@{
                    FileSystemLabel = 'DRIVEPOOL4'; DriveLetter = $null; FileSystem = 'NTFS'
                    Size            = 14000519643136; SizeRemaining = 900000000000
                    Path            = '\\?\Volume{aaaa}\'; DriveType = 'Fixed'
                },
                [pscustomobject]@{
                    FileSystemLabel = 'SSDPOOl1'; DriveLetter = 'M'; FileSystem = 'NTFS'
                    Size            = 2000000000000; SizeRemaining = 100000000000
                    Path            = '\\?\Volume{bbbb}\'; DriveType = 'Fixed'
                },
                [pscustomobject]@{
                    FileSystemLabel = 'Backup stick'; DriveLetter = 'X'; FileSystem = 'NTFS'
                    Size            = 64000000000; SizeRemaining = 1
                    Path            = '\\?\Volume{cccc}\'; DriveType = 'Removable'
                }
            )
        }
        Mock Get-Partition {
            @(
                [pscustomobject]@{
                    DiskNumber = 4; PartitionNumber = 2
                    AccessPaths = @('\\?\Volume{aaaa}\'); IsSystem = $false; IsBoot = $false
                },
                [pscustomobject]@{
                    DiskNumber = 1; PartitionNumber = 1
                    AccessPaths = @('M:\', '\\?\Volume{bbbb}\'); IsSystem = $false; IsBoot = $false
                }
            )
        }
    }

    It 'matches a letterless volume to its partition through the volume GUID path' {
        $rows = @(Get-MountCandidate)
        $part = $rows | Where-Object { $_.Label -eq 'DRIVEPOOL4' }
        $part.DiskNumber | Should -Be 4
        $part.PartitionNumber | Should -Be 2
        $part.Reachable | Should -BeFalse
    }

    It 'leaves volumes that are already reachable alone' {
        $rows = @(Get-MountCandidate)
        ($rows | Where-Object { $_.Label -eq 'SSDPOOl1' }).WslPath | Should -Be '/mnt/m'
    }

    It 'ignores removable drives' {
        @(Get-MountCandidate).Label | Should -Not -Contain 'Backup stick'
    }

    It 'numbers the rows so the picker can refer to them' {
        @(Get-MountCandidate).Index | Should -Be @(1, 2)
    }
}

# This suite lives here rather than in Agent.Tests.ps1 because it is about the files
# themselves, not about any one function in them.
Describe 'Every PowerShell file is safe for Windows PowerShell 5.1' {
    BeforeAll {
        $script:AgentRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
        $script:PowerShellFiles = @(
            Get-ChildItem -Path $script:AgentRoot -Recurse -Include '*.ps1', '*.psm1' -File |
                Sort-Object FullName
        )
    }

    It 'finds the agent, the installer, the tools and the tests' {
        $script:PowerShellFiles.Count | Should -BeGreaterOrEqual 5
    }

    <#
        Windows PowerShell 5.1 -- which is what ships with Windows Server, and what the
        host runs -- reads a .ps1 as the ANSI codepage unless it has a UTF-8 BOM. On a
        Western install that is Windows-1252, so a UTF-8 em dash (E2 80 94) arrives as
        "a", "EUR", and 0x94 -- which is U+201D, a smart closing quote. PowerShell accepts
        smart quotes as string delimiters, so the string ends early and the rest of the
        file fails to parse. It cost the whole agent: every file had at least one.

        Keeping the files pure ASCII fixes it regardless of codepage or BOM, and keeps
        the console output legible too. This test is the guard.
    #>
    It 'contains no character that changes meaning under a different codepage' {
        foreach ($file in $script:PowerShellFiles) {
            $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
            $offending = @()
            for ($i = 0; $i -lt $bytes.Length; $i++) {
                if ($bytes[$i] -gt 127) {
                    $line = ([System.Text.Encoding]::UTF8.GetString($bytes, 0, $i) -split "`n").Count
                    $offending += "byte 0x{0:X2} at line {1}" -f $bytes[$i], $line
                    if ($offending.Count -ge 3) { break }
                }
            }
            $offending -join '; ' | Should -BeNullOrEmpty -Because "$($file.Name) must be pure ASCII"
        }
    }

    # The same file read as Windows-1252 has to be the same script. For ASCII bytes it
    # trivially is, which is the point: this asserts the property that makes it so.
    It 'parses identically whether read as UTF-8 or as the ANSI codepage' {
        foreach ($file in $script:PowerShellFiles) {
            $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
            $utf8 = [System.Text.Encoding]::UTF8.GetString($bytes)
            $ansi = [System.Text.Encoding]::GetEncoding(1252).GetString($bytes)
            $ansi | Should -Be $utf8 -Because "$($file.Name) must read the same on a 1252 console"
        }
    }

    It 'parses without error' {
        foreach ($file in $script:PowerShellFiles) {
            $errors = $null
            $tokens = $null
            [System.Management.Automation.Language.Parser]::ParseFile(
                $file.FullName, [ref]$tokens, [ref]$errors) | Out-Null
            ($errors | ForEach-Object { "$($file.Name):$($_.Extent.StartLineNumber) $($_.Message)" }) -join "`n" |
                Should -BeNullOrEmpty
        }
    }
}

<#
    Running the thing, not just its parts.

    The pure functions were well covered and the script still failed on the host, at
    "Which volumes should I $verb?" -- PowerShell allows '?' in a variable name, so it
    looked up a variable called "verb?" and threw under StrictMode. It parses cleanly;
    only executing that branch finds it. These tests execute every branch.
#>
Describe 'Running the picker end to end' {
    BeforeAll {
        # Stubs for the Windows-only Storage cmdlets. They need the real parameters:
        # without them nothing binds, so -ParameterFilter { $DiskNumber ... } can never
        # match and the mock that reads the access paths back never fires.
        function Get-Volume { param($FileSystemLabel) }
        function Get-Partition { param($DiskNumber, $PartitionNumber, $Volume) }
        function Add-PartitionAccessPath { param($DiskNumber, $PartitionNumber, $AccessPath) }
        function Remove-PartitionAccessPath { param($DiskNumber, $PartitionNumber, $AccessPath) }

        # tokyo-3's real layout, trimmed: two pool disks, a recovery partition, the
        # system volume, and one volume that already has a letter.
        function Set-Layout {
            Mock Get-Volume {
                @(
                    [pscustomobject]@{ FileSystemLabel = 'DRIVEPOOL4'; DriveLetter = $null; FileSystem = 'NTFS'
                        Size = 8001563222016; SizeRemaining = 1; Path = '\\?\Volume{a}\'; DriveType = 'Fixed' },
                    [pscustomobject]@{ FileSystemLabel = 'DRIVEPOOL9'; DriveLetter = $null; FileSystem = 'NTFS'
                        Size = 8001563222016; SizeRemaining = 1; Path = '\\?\Volume{b}\'; DriveType = 'Fixed' },
                    [pscustomobject]@{ FileSystemLabel = 'Recovery'; DriveLetter = $null; FileSystem = 'NTFS'
                        Size = 471859200; SizeRemaining = 1; Path = '\\?\Volume{c}\'; DriveType = 'Fixed' },
                    [pscustomobject]@{ FileSystemLabel = 'SSDPool'; DriveLetter = 'M'; FileSystem = 'NTFS'
                        Size = 2967184834560; SizeRemaining = 1; Path = '\\?\Volume{d}\'; DriveType = 'Fixed' }
                )
            }
            Mock Get-Partition {
                $recovery = [pscustomobject]@{ DiskNumber = 0; PartitionNumber = 4
                    AccessPaths = @('\\?\Volume{c}\'); IsSystem = $false; IsBoot = $false }
                $recovery | Add-Member -NotePropertyName GptType -NotePropertyValue '{de94bba4-06d1-4d40-a16a-bfd50179d6ac}'
                @(
                    [pscustomobject]@{ DiskNumber = 4; PartitionNumber = 2
                        AccessPaths = @('\\?\Volume{a}\'); IsSystem = $false; IsBoot = $false },
                    [pscustomobject]@{ DiskNumber = 9; PartitionNumber = 2
                        AccessPaths = @('\\?\Volume{b}\'); IsSystem = $false; IsBoot = $false },
                    $recovery,
                    [pscustomobject]@{ DiskNumber = 1; PartitionNumber = 1
                        AccessPaths = @('M:\', '\\?\Volume{d}\'); IsSystem = $false; IsBoot = $false }
                )
            }
            Mock Assert-Administrator { }
            Mock Add-PartitionAccessPath { }
            Mock New-Item { }
            Mock Test-Path { $false }
            # Verification after mounting reads the access paths back.
            Mock Get-Partition -ParameterFilter { $null -ne $DiskNumber } {
                [pscustomobject]@{ DiskNumber = $DiskNumber; PartitionNumber = $PartitionNumber
                    AccessPaths = @("C:\PoolDisks\DRIVEPOOL$DiskNumber") }
            }
        }
    }

    BeforeEach { Set-Layout }

    It 'lists without asking anything and changes nothing' {
        Mock Read-Host { throw 'must not prompt in -ListOnly' }
        { Invoke-Main -ListOnly } | Should -Not -Throw
        Should -Invoke Add-PartitionAccessPath -Times 0
    }

    # The regression: this branch interpolates the verb into the prompt.
    It 'prompts, and mounts exactly what was selected' {
        Mock Read-Host { '1' }
        { Invoke-Main } | Should -Not -Throw
        Should -Invoke Add-PartitionAccessPath -Times 1
        Should -Invoke Add-PartitionAccessPath -Times 1 -ParameterFilter {
            $AccessPath -eq 'C:\PoolDisks\DRIVEPOOL4'
        }
    }

    It 'prompts with the unmount wording too, which is the other half of that branch' {
        Mock Read-Host { '' }
        { Invoke-Main -Remove } | Should -Not -Throw
    }

    It 'takes a range' {
        Mock Read-Host { '1-2' }
        Invoke-Main
        Should -Invoke Add-PartitionAccessPath -Times 2
    }

    It 'treats a blank answer as cancel' {
        Mock Read-Host { '' }
        Invoke-Main
        Should -Invoke Add-PartitionAccessPath -Times 0
    }

    It 'mounts every candidate with -All, and no recovery partition among them' {
        Mock Read-Host { throw 'must not prompt with -All' }
        Invoke-Main -All
        Should -Invoke Add-PartitionAccessPath -Times 2
        Should -Invoke Add-PartitionAccessPath -Times 0 -ParameterFilter { $DiskNumber -eq 0 }
    }

    It 'mounts by label without prompting' {
        Mock Read-Host { throw 'must not prompt with -Label' }
        Invoke-Main -Label 'DRIVEPOOL9'
        Should -Invoke Add-PartitionAccessPath -Times 1 -ParameterFilter { $DiskNumber -eq 9 }
    }

    It 'stops on a label that is not there rather than mounting something else' {
        { Invoke-Main -Label 'NOPE' } | Should -Throw '*No volume labelled*'
        Should -Invoke Add-PartitionAccessPath -Times 0
    }

    It 'writes nothing under -WhatIf' {
        Mock Read-Host { 'all' }
        Invoke-Main -WhatIf
        Should -Invoke Add-PartitionAccessPath -Times 0
        Should -Invoke New-Item -Times 0
    }

    It 'honours a different mount root' {
        Mock Read-Host { '1' }
        Invoke-Main -MountRoot 'D:\Disks'
        Should -Invoke Add-PartitionAccessPath -Times 1 -ParameterFilter {
            $AccessPath -eq 'D:\Disks\DRIVEPOOL4'
        }
    }

    # One disk failing must not abandon the other thirteen.
    It 'carries on after one volume fails' {
        Mock Read-Host { '1-2' }
        Mock Add-PartitionAccessPath -ParameterFilter { $DiskNumber -eq 4 } { throw 'device is busy' }
        { Invoke-Main } | Should -Not -Throw
        Should -Invoke Add-PartitionAccessPath -Times 1 -ParameterFilter { $DiskNumber -eq 9 }
    }

    It 'refuses a target directory that is not empty' {
        Mock Read-Host { '1' }
        Mock Test-Path { $true }
        Mock Get-ChildItem { @([pscustomobject]@{ Name = 'something.txt' }) }
        { Invoke-Main } | Should -Not -Throw
        Should -Invoke Add-PartitionAccessPath -Times 0
    }

    It 'says so and stops when there are no volumes at all' {
        Mock Get-Volume { @() }
        { Invoke-Main -ListOnly } | Should -Not -Throw
    }
}
