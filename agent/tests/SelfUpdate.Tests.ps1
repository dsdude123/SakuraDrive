#Requires -Modules Pester

<#
.SYNOPSIS
    The agent replacing itself with what the server ships.

.DESCRIPTION
    Fixing the agent has meant copying files onto a Windows box by hand every time, so
    the server ships the agent and the host updates itself. That makes the update path
    the most dangerous code here: a bad update breaks the only thing that can install
    the fix.

    So these tests are mostly about refusing. A file whose hash does not match, a file
    that will not parse, a version that has already broken this host -- each of those
    has to leave a working agent exactly as it was.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'SakuraDrive.Agent.psm1') -Force

    function New-TestRoot {
        $path = Join-Path ([System.IO.Path]::GetTempPath()) ("sakuradrive-update-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        $path
    }

    function Set-TestFile {
        param([string] $Root, [string] $RelativePath, [string] $Content)

        $full = Join-Path $Root ($RelativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
        New-Item -ItemType Directory -Path (Split-Path -Parent $full) -Force | Out-Null
        # No BOM and no trailing newline the caller did not ask for: the hash has to be
        # of exactly these bytes.
        [System.IO.File]::WriteAllText($full, $Content, (New-Object System.Text.UTF8Encoding($false)))
        $full
    }

    function New-TestManifest {
        <#
        .SYNOPSIS
            A manifest describing whatever is in a directory, shaped like the server's.
        #>
        param([string] $Directory, [string] $Version = 'aaaaaaaaaaaa')

        $files = @()
        foreach ($item in Get-ChildItem -LiteralPath $Directory -Recurse -File) {
            $relative = $item.FullName.Substring($Directory.Length).TrimStart('\', '/').Replace('\', '/')
            $files += [pscustomobject]@{
                path   = $relative
                sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                bytes  = $item.Length
            }
        }
        [pscustomobject]@{
            version         = $Version
            agentVersion    = '1.0.0'
            protocolVersion = 1
            generatedAt     = '2026-09-01T00:00:00Z'
            files           = @($files)
        }
    }
}

Describe 'The distribution file list' {
    It 'names the files an installation is made of' {
        $files = Get-AgentDistributionFile
        $files | Should -Contain 'SakuraDriveAgent.ps1'
        $files | Should -Contain 'SakuraDrive.Agent.psm1'
        $files | Should -Contain 'Bootstrap-SakuraDriveAgent.ps1'
        $files | Should -Contain 'Uninstall-SakuraDriveAgent.ps1'
    }

    # The list drives what the installer copies, so a name that does not exist would
    # fail an install on a host rather than here.
    It 'names only files that are actually in the repository' {
        $root = Join-Path $PSScriptRoot '..'
        foreach ($file in Get-AgentDistributionFile) {
            $full = Join-Path $root ($file.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
            Test-Path -LiteralPath $full -PathType Leaf | Should -BeTrue -Because "$file should exist"
        }
    }

    It 'does not ship the tests, which need Pester and fixtures that are not shipped' {
        Get-AgentDistributionFile | Where-Object { $_ -like 'tests/*' } | Should -BeNullOrEmpty
    }
}

Describe 'Checking that a script will parse' {
    BeforeEach { $script:Root = New-TestRoot }
    AfterEach { Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue }

    It 'passes a file that parses' {
        $path = Set-TestFile -Root $script:Root -RelativePath 'good.ps1' -Content "function Get-Thing { 'x' }`n"
        (Test-AgentScriptSyntax -Path $path).Count | Should -Be 0
    }

    <#
        The exact failure this exists for: a UTF-8 file read as the ANSI codepage turns
        an em dash into a smart quote, which terminates the string it is inside and
        breaks the parse. That is what took the agent down on the host, and it is why an
        update is parsed before it is allowed to replace a working one.
    #>
    It 'catches an unterminated string' {
        $path = Set-TestFile -Root $script:Root -RelativePath 'bad.ps1' -Content "`$x = 'never closed`n"
        $problems = Test-AgentScriptSyntax -Path $path
        $problems.Count | Should -BeGreaterThan 0
        $problems -join ' ' | Should -Match 'bad.ps1'
    }

    It 'catches an unclosed block' {
        $path = Set-TestFile -Root $script:Root -RelativePath 'bad.ps1' -Content "function Get-Thing {`n"
        (Test-AgentScriptSyntax -Path $path).Count | Should -BeGreaterThan 0
    }

    It 'reports a missing file rather than pretending it parsed' {
        $problems = Test-AgentScriptSyntax -Path (Join-Path $script:Root 'absent.ps1')
        $problems.Count | Should -Be 1
        $problems[0] | Should -Match 'missing'
    }
}

Describe 'Checking a directory against a manifest' {
    BeforeEach {
        $script:Root = New-TestRoot
        Set-TestFile -Root $script:Root -RelativePath 'SakuraDriveAgent.ps1' -Content "'agent'`n" | Out-Null
        Set-TestFile -Root $script:Root -RelativePath 'tools/Mount.ps1' -Content "'tool'`n" | Out-Null
        $script:Manifest = New-TestManifest -Directory $script:Root
    }
    AfterEach { Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue }

    It 'accepts a directory that matches' {
        (Test-AgentDistribution -Directory $script:Root -Manifest $script:Manifest).Count | Should -Be 0
    }

    <#
        A result that has to be assigned to be counted correctly is a trap, and one this
        already fell into: wrapping the call in @() made an empty result look like one
        problem, which would have made the agent refuse every update it was offered.
    #>
    It 'returns an empty array, not an array holding an empty array' {
        $problems = Test-AgentDistribution -Directory $script:Root -Manifest $script:Manifest
        $problems.GetType().Name | Should -Be 'String[]'
        $problems.Count | Should -Be 0
    }

    It 'reports a file that is missing' {
        Remove-Item -LiteralPath (Join-Path $script:Root 'SakuraDriveAgent.ps1') -Force
        $problems = Test-AgentDistribution -Directory $script:Root -Manifest $script:Manifest
        $problems -join ' ' | Should -Match 'SakuraDriveAgent.ps1 is missing'
    }

    # A truncated download, or something in the middle rewriting the body.
    It 'reports a file whose content is not what the manifest said' {
        Set-TestFile -Root $script:Root -RelativePath 'SakuraDriveAgent.ps1' -Content "'tampered'`n" | Out-Null
        $problems = Test-AgentDistribution -Directory $script:Root -Manifest $script:Manifest
        $problems -join ' ' | Should -Match 'does not match the manifest'
    }

    It 'reports a file that hashes correctly but will not parse' {
        Set-TestFile -Root $script:Root -RelativePath 'SakuraDriveAgent.ps1' -Content "`$x = 'unterminated`n" | Out-Null
        $manifest = New-TestManifest -Directory $script:Root
        $problems = Test-AgentDistribution -Directory $script:Root -Manifest $manifest
        $problems.Count | Should -BeGreaterThan 0
        $problems -join ' ' | Should -Not -Match 'does not match the manifest'
    }

    It 'reports an empty manifest rather than silently approving' {
        $problems = Test-AgentDistribution -Directory $script:Root -Manifest ([pscustomobject]@{ files = @() })
        $problems -join ' ' | Should -Match 'no files'
    }

    It 'checks files in subdirectories too' {
        Set-TestFile -Root $script:Root -RelativePath 'tools/Mount.ps1' -Content "'changed'`n" | Out-Null
        (Test-AgentDistribution -Directory $script:Root -Manifest $script:Manifest).Count | Should -Be 1
    }
}

Describe 'The update state file' {
    BeforeEach { $script:Root = New-TestRoot }
    AfterEach { Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue }

    It 'round-trips what was written' {
        Write-AgentUpdateState -InstallPath $script:Root -State (New-AgentUpdateState `
                -Version 'abc123' -AgentVersion '1.0.0' -Stage 'pending' -Attempts 1 -PreviousVersion 'old999') | Out-Null

        $state = Read-AgentUpdateState -InstallPath $script:Root
        $state.version | Should -Be 'abc123'
        $state.stage | Should -Be 'pending'
        $state.attempts | Should -Be 1
        $state.previousVersion | Should -Be 'old999'
    }

    It 'returns nothing when there is no state file' {
        Read-AgentUpdateState -InstallPath $script:Root | Should -BeNullOrEmpty
    }

    # A state file truncated by a power cut must not stop the agent starting; the next
    # check reconciles against the manifest and writes a good one.
    It 'treats an unreadable state file as unknown rather than throwing' {
        Set-TestFile -Root $script:Root -RelativePath 'update-state.json' -Content '{ this is not json' | Out-Null
        Read-AgentUpdateState -InstallPath $script:Root | Should -BeNullOrEmpty
    }

    It 'fills in keys a state file written by an older agent does not have' {
        Set-TestFile -Root $script:Root -RelativePath 'update-state.json' -Content '{"version":"abc123"}' | Out-Null
        $state = Read-AgentUpdateState -InstallPath $script:Root
        $state.version | Should -Be 'abc123'
        $state.stage | Should -Be 'confirmed'
        $state.blockedVersion | Should -Be ''
    }
}

Describe 'Deciding whether a version has proved itself' {
    It 'has nothing to say about an installation with no state' {
        Resolve-AgentUpdateOutcome -State $null | Should -Be 'unknown'
    }

    It 'leaves a confirmed version alone' {
        Resolve-AgentUpdateOutcome -State (New-AgentUpdateState -Version 'v1' -Stage 'confirmed') | Should -Be 'ok'
    }

    It 'puts a freshly installed version on probation' {
        Resolve-AgentUpdateOutcome -State (New-AgentUpdateState -Version 'v2' -Stage 'pending' -Attempts 0) |
            Should -Be 'verify'
    }

    It 'gives it a second chance' {
        Resolve-AgentUpdateOutcome -State (New-AgentUpdateState -Version 'v2' -Stage 'pending' -Attempts 1) |
            Should -Be 'verify'
    }

    # Two runs that never got as far as posting a report. The version that was working
    # goes back rather than leaving the host silently unmonitored.
    It 'rolls back after two runs that never confirmed' {
        Resolve-AgentUpdateOutcome -State (New-AgentUpdateState -Version 'v2' -Stage 'pending' -Attempts 2) |
            Should -Be 'rollback'
    }

    It 'honours a different attempt limit' {
        $state = New-AgentUpdateState -Version 'v2' -Stage 'pending' -Attempts 2
        Resolve-AgentUpdateOutcome -State $state -MaxAttempts 5 | Should -Be 'verify'
    }
}

Describe 'Installing a verified update' {
    BeforeEach {
        $script:Install = New-TestRoot
        $script:Staging = New-TestRoot

        Set-TestFile -Root $script:Install -RelativePath 'SakuraDriveAgent.ps1' -Content "'version one'`n" | Out-Null
        Set-TestFile -Root $script:Install -RelativePath 'tools/Mount.ps1' -Content "'tool one'`n" | Out-Null
        Set-TestFile -Root $script:Install -RelativePath 'agent.config.json' -Content '{"Token":"keep me"}' | Out-Null

        Set-TestFile -Root $script:Staging -RelativePath 'SakuraDriveAgent.ps1' -Content "'version two'`n" | Out-Null
        Set-TestFile -Root $script:Staging -RelativePath 'tools/Mount.ps1' -Content "'tool two'`n" | Out-Null
        $script:Manifest = New-TestManifest -Directory $script:Staging -Version 'bbbbbbbbbbbb'
    }
    AfterEach {
        Remove-Item -LiteralPath $script:Install -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $script:Staging -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'replaces the files the manifest names' {
        Save-AgentUpdate -InstallPath $script:Install -StagingPath $script:Staging -Manifest $script:Manifest |
            Should -BeTrue
        Get-Content -LiteralPath (Join-Path $script:Install 'SakuraDriveAgent.ps1') -Raw |
            Should -Match 'version two'
        Get-Content -LiteralPath (Join-Path $script:Install 'tools/Mount.ps1') -Raw | Should -Match 'tool two'
    }

    # The token and any tuning an operator did live here. An update is not a reinstall.
    It 'leaves the configuration alone' {
        Save-AgentUpdate -InstallPath $script:Install -StagingPath $script:Staging -Manifest $script:Manifest | Out-Null
        Get-Content -LiteralPath (Join-Path $script:Install 'agent.config.json') -Raw | Should -Match 'keep me'
    }

    It 'keeps the files it replaced so they can be put back' {
        Save-AgentUpdate -InstallPath $script:Install -StagingPath $script:Staging -Manifest $script:Manifest | Out-Null
        Get-Content -LiteralPath (Join-Path $script:Install '.previous/SakuraDriveAgent.ps1') -Raw |
            Should -Match 'version one'
    }

    It 'puts the previous files back' {
        Save-AgentUpdate -InstallPath $script:Install -StagingPath $script:Staging -Manifest $script:Manifest | Out-Null
        Undo-AgentUpdate -InstallPath $script:Install | Should -BeTrue

        Get-Content -LiteralPath (Join-Path $script:Install 'SakuraDriveAgent.ps1') -Raw | Should -Match 'version one'
        Get-Content -LiteralPath (Join-Path $script:Install 'tools/Mount.ps1') -Raw | Should -Match 'tool one'
    }

    It 'says so rather than throwing when there is nothing to roll back to' {
        Undo-AgentUpdate -InstallPath $script:Install | Should -BeFalse
    }

    # Two updates in a row: the second must not leave the first update's files behind
    # in .previous, or a rollback would go back two versions instead of one.
    It 'keeps only the version it just replaced' {
        Save-AgentUpdate -InstallPath $script:Install -StagingPath $script:Staging -Manifest $script:Manifest | Out-Null

        Set-TestFile -Root $script:Staging -RelativePath 'SakuraDriveAgent.ps1' -Content "'version three'`n" | Out-Null
        $third = New-TestManifest -Directory $script:Staging -Version 'cccccccccccc'
        Save-AgentUpdate -InstallPath $script:Install -StagingPath $script:Staging -Manifest $third | Out-Null

        Get-Content -LiteralPath (Join-Path $script:Install '.previous/SakuraDriveAgent.ps1') -Raw |
            Should -Match 'version two'
    }

    It 'installs a file the previous version did not have at all' {
        Set-TestFile -Root $script:Staging -RelativePath 'tools/New-Thing.ps1' -Content "'brand new'`n" | Out-Null
        $manifest = New-TestManifest -Directory $script:Staging -Version 'dddddddddddd'
        Save-AgentUpdate -InstallPath $script:Install -StagingPath $script:Staging -Manifest $manifest | Out-Null
        Test-Path -LiteralPath (Join-Path $script:Install 'tools/New-Thing.ps1') | Should -BeTrue
    }

    It 'changes nothing when told not to' {
        Save-AgentUpdate -InstallPath $script:Install -StagingPath $script:Staging -Manifest $script:Manifest -WhatIf |
            Out-Null
        Get-Content -LiteralPath (Join-Path $script:Install 'SakuraDriveAgent.ps1') -Raw | Should -Match 'version one'
    }
}

<#
    End to end, without a server: build a "distribution", install it, break it, and check
    that the host ends up back on the version that worked.
#>
Describe 'A bad update and the way back' {
    BeforeEach {
        $script:Install = New-TestRoot
        $script:Staging = New-TestRoot
        Set-TestFile -Root $script:Install -RelativePath 'SakuraDriveAgent.ps1' -Content "'good'`n" | Out-Null
        Write-AgentUpdateState -InstallPath $script:Install `
            -State (New-AgentUpdateState -Version 'good00000000' -Stage 'confirmed') | Out-Null
    }
    AfterEach {
        Remove-Item -LiteralPath $script:Install -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $script:Staging -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'never installs a version that will not parse' {
        Set-TestFile -Root $script:Staging -RelativePath 'SakuraDriveAgent.ps1' -Content "`$x = 'unterminated`n" | Out-Null
        $manifest = New-TestManifest -Directory $script:Staging -Version 'bad000000000'

        (Test-AgentDistribution -Directory $script:Staging -Manifest $manifest).Count |
            Should -BeGreaterThan 0

        # The caller stops here, so the working file is untouched.
        Get-Content -LiteralPath (Join-Path $script:Install 'SakuraDriveAgent.ps1') -Raw | Should -Match 'good'
    }

    It 'restores the working version after two runs that never confirmed' {
        Set-TestFile -Root $script:Staging -RelativePath 'SakuraDriveAgent.ps1' -Content "'broken but valid'`n" | Out-Null
        $manifest = New-TestManifest -Directory $script:Staging -Version 'bad000000000'

        Save-AgentUpdate -InstallPath $script:Install -StagingPath $script:Staging -Manifest $manifest | Out-Null
        $state = Write-AgentUpdateState -InstallPath $script:Install -State (New-AgentUpdateState `
                -Version 'bad000000000' -Stage 'pending' -PreviousVersion 'good00000000')

        # Two starts that never reach a successful report.
        foreach ($attempt in 1, 2) {
            $state = Read-AgentUpdateState -InstallPath $script:Install
            if ((Resolve-AgentUpdateOutcome -State $state) -eq 'verify') {
                $state['attempts'] = [int]$state['attempts'] + 1
                Write-AgentUpdateState -InstallPath $script:Install -State $state | Out-Null
            }
        }

        $state = Read-AgentUpdateState -InstallPath $script:Install
        Resolve-AgentUpdateOutcome -State $state | Should -Be 'rollback'

        Undo-AgentUpdate -InstallPath $script:Install | Should -BeTrue
        Get-Content -LiteralPath (Join-Path $script:Install 'SakuraDriveAgent.ps1') -Raw | Should -Match 'good'
    }

    # Otherwise the host would update, break, roll back and update again every interval.
    It 'records the failed version so it is not installed again' {
        $restored = New-AgentUpdateState -Version 'good00000000' -Stage 'confirmed' `
            -BlockedVersion 'bad000000000' -BlockedReason 'Version bad000000000 did not complete a run after two attempts.'
        Write-AgentUpdateState -InstallPath $script:Install -State $restored | Out-Null

        $state = Read-AgentUpdateState -InstallPath $script:Install
        $state.blockedVersion | Should -Be 'bad000000000'
        $state.blockedReason | Should -Match 'two attempts'
    }

    It 'clears probation once a run confirms it' {
        Write-AgentUpdateState -InstallPath $script:Install -State (New-AgentUpdateState `
                -Version 'new000000000' -Stage 'pending' -Attempts 1) | Out-Null

        $state = Read-AgentUpdateState -InstallPath $script:Install
        $state['stage'] = 'confirmed'
        $state['attempts'] = 0
        Write-AgentUpdateState -InstallPath $script:Install -State $state | Out-Null

        Resolve-AgentUpdateOutcome -State (Read-AgentUpdateState -InstallPath $script:Install) | Should -Be 'ok'
    }
}

Describe 'The report carries the distribution the host is running' {
    It 'includes it when the host knows' {
        $report = New-AgentReport -Hostname 'tokyo-3' -DistributionVersion 'abc123def456'
        $report.distributionVersion | Should -Be 'abc123def456'
    }

    # An agent installed by copying files does not know, and that is not an error.
    It 'sends an empty string when it does not' {
        (New-AgentReport -Hostname 'tokyo-3').distributionVersion | Should -Be ''
    }
}

<#
    Reading a property off whatever came back from the server, under Set-StrictMode.
    This is not hypothetical: "no work" arrives as 204 No Content, Invoke-RestMethod
    turns that into an empty string, and reading .job off it threw and failed the whole
    cycle every fifteen minutes on a host with nothing to do.
#>
Describe 'Reading what the server sent back' {
    Context 'a claim response' {
        It 'finds the job when there is one' {
            $response = [pscustomobject]@{ job = [pscustomobject]@{ jobId = 4; type = 'catalog.scan' } }
            (Get-AgentJobFromClaim -Response $response).jobId | Should -Be 4
        }

        # 204 No Content, which is what the server sends when it has nothing queued.
        It 'says there is no work for the empty string a 204 becomes' {
            Get-AgentJobFromClaim -Response '' | Should -BeNullOrEmpty
        }

        It 'says there is no work for null' {
            Get-AgentJobFromClaim -Response $null | Should -BeNullOrEmpty
        }

        It 'says there is no work for a response with no job in it' {
            Get-AgentJobFromClaim -Response ([pscustomobject]@{ somethingElse = 1 }) | Should -BeNullOrEmpty
        }

        It 'says there is no work when the job is explicitly null' {
            Get-AgentJobFromClaim -Response ([pscustomobject]@{ job = $null }) | Should -BeNullOrEmpty
        }
    }

    Context 'a batch response' {
        It 'keeps going when the server says so' {
            Test-AgentJobContinue -Response ([pscustomobject]@{ accepted = 10; continue = $true }) |
                Should -BeTrue
        }

        It 'stops when the server says so' {
            Test-AgentJobContinue -Response ([pscustomobject]@{ accepted = 10; continue = $false }) |
                Should -BeFalse
        }

        # Stopping costs nothing: the cursor went up with the batch, so the next window
        # resumes rather than restarts.
        It 'stops rather than guessing when the answer is missing or unreadable' {
            Test-AgentJobContinue -Response $null | Should -BeFalse
            Test-AgentJobContinue -Response '' | Should -BeFalse
            Test-AgentJobContinue -Response ([pscustomobject]@{ accepted = 0 }) | Should -BeFalse
        }
    }
}

<#
    Where the update check sits in the run, asserted against the script itself.

    An agent too broken to finish a cycle is the one that most needs the fix the server
    is holding. If the update check were inside the try that catches a failed cycle, the
    first bug to throw before it would lock the host onto that version permanently --
    which is exactly what happened once, and is not the kind of thing a unit test of a
    function can catch.
#>
Describe 'The update check runs even when the cycle fails' {
    BeforeAll {
        $script:AgentScript = (Resolve-Path (Join-Path $PSScriptRoot '..' 'SakuraDriveAgent.ps1')).Path
        $errors = $null
        $tokens = $null
        $script:Ast = [System.Management.Automation.Language.Parser]::ParseFile(
            $script:AgentScript, [ref]$tokens, [ref]$errors)
        $errors.Count | Should -Be 0

        # The try that wraps a reporting cycle: the one whose catch logs "Report failed".
        $script:CycleTry = $script:Ast.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.TryStatementAst] -and
                $node.CatchClauses.Extent.Text -match 'Report failed'
            }, $true) | Select-Object -First 1

        $script:UpdateCalls = @($script:Ast.FindAll({
                    param($node)
                    $node -is [System.Management.Automation.Language.CommandAst] -and
                    $node.GetCommandName() -eq 'Invoke-AgentSelfUpdate'
                }, $true))
    }

    It 'finds the cycle and the update check in the script' {
        $script:CycleTry | Should -Not -BeNullOrEmpty
        $script:UpdateCalls.Count | Should -Be 1
    }

    It 'does not put the update check inside the block that a failed cycle escapes' {
        $body = $script:CycleTry.Body.Extent
        foreach ($call in $script:UpdateCalls) {
            $offset = $call.Extent.StartOffset
            ($offset -ge $body.StartOffset -and $offset -le $body.EndOffset) |
                Should -BeFalse -Because 'a cycle that throws must still be able to replace the agent'
        }
    }

    # The other half: it must not run before the report either, or a host would replace
    # itself without ever saying what it saw.
    It 'runs after the report, not before it' {
        $send = $script:Ast.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.CommandAst] -and
                $node.GetCommandName() -eq 'Send-AgentReport'
            }, $true) | Select-Object -First 1

        $send | Should -Not -BeNullOrEmpty
        $script:UpdateCalls[0].Extent.StartOffset | Should -BeGreaterThan $send.Extent.StartOffset
    }

    # An update that throws is a warning, not the end of the run.
    It 'catches whatever the update check throws' {
        $wrapping = $script:Ast.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.TryStatementAst] -and
                $node.Body.Extent.Text -match 'Invoke-AgentSelfUpdate'
            }, $true)
        $wrapping.Count | Should -BeGreaterThan 0
    }
}
