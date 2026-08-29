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

    # The volume GUID path is exactly what WSL cannot reach — the reason for this script.
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
        function Get-Volume { }
        function Get-Partition { }

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
