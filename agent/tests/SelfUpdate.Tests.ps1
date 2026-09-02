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

<#
    Reading a scheduled task's last result.

    267009 is "still running", and the installer printed it under the heading
    "0 means success" -- so a perfectly healthy install looked like a failure on a real
    host. On a large array the first pass reads SMART for every disk and takes minutes,
    which makes that the normal outcome of an install rather than an edge case.
#>
Describe 'What a scheduled task result code means' {
    It 'reports a clean exit' {
        $result = Get-ScheduledTaskResultText -Code 0
        $result.ok | Should -BeTrue
        $result.running | Should -BeFalse
        $result.text | Should -Match 'cleanly'
    }

    It 'reports 267009 as still running, not as a failure' {
        $result = Get-ScheduledTaskResultText -Code 267009
        $result.ok | Should -BeTrue
        $result.running | Should -BeTrue
        $result.text | Should -Match 'still running'
    }

    It 'treats waiting for its next run as fine' {
        (Get-ScheduledTaskResultText -Code 267008).ok | Should -BeTrue
        (Get-ScheduledTaskResultText -Code 267011).ok | Should -BeTrue
    }

    # The agent's own exit codes, so the installer can say which of the two went wrong
    # instead of printing a bare number.
    It 'separates a bad configuration from an unreachable server' {
        $config = Get-ScheduledTaskResultText -Code 1
        $config.ok | Should -BeFalse
        $config.text | Should -Match 'configuration'

        $server = Get-ScheduledTaskResultText -Code 2
        $server.ok | Should -BeFalse
        $server.text | Should -Match 'report'
    }

    It 'names the states that need someone to do something' {
        (Get-ScheduledTaskResultText -Code 267010).text | Should -Match 'disabled'
        (Get-ScheduledTaskResultText -Code 267014).text | Should -Match 'stopped'
        (Get-ScheduledTaskResultText -Code 2147942402).text | Should -Match 'not found'
        (Get-ScheduledTaskResultText -Code 2147942405).text | Should -Match 'Access denied'
    }

    It 'falls back to the number in hex rather than pretending to know' {
        $result = Get-ScheduledTaskResultText -Code 3221225477
        $result.ok | Should -BeFalse
        $result.text | Should -Match '0xC0000005'
    }

    It 'treats a missing code as a clean exit rather than throwing' {
        (Get-ScheduledTaskResultText -Code $null).ok | Should -BeTrue
    }
}

<#
    How a request body is encoded.

    This is the bug that broke the first real catalog scan. Windows PowerShell 5.1 --
    what the host runs -- encodes a string body as ISO-8859-1 when the content type
    names no charset. "Cafe Society.mkv" with an accent went out as a lone 0xE9 byte,
    which is not valid UTF-8, so the server could not parse the JSON and answered
    400 Bad Request with nothing useful in it.

    Every test until now ran on PowerShell 7 on Linux, which defaults to UTF-8, so the
    whole class of failure was invisible here and certain on the host: a media pool is
    mostly non-ASCII filenames.
#>
Describe 'Encoding a request body' {
    It 'returns bytes, not a string' {
        $bytes = ConvertTo-AgentJsonBody -Body ([ordered]@{ a = 1 })
        $bytes -is [byte[]] | Should -BeTrue
    }

    # The exact bytes, because this is the whole bug: UTF-8 spells e-acute C3 A9 and
    # ISO-8859-1 spells it E9.
    It 'encodes a non-ASCII character as UTF-8, never as ISO-8859-1' {
        $name = 'Caf' + [char]0xE9 + '.mkv'
        $bytes = ConvertTo-AgentJsonBody -Body ([ordered]@{ relPath = $name })

        $bytes -contains 0xC3 | Should -BeTrue -Because 'UTF-8 encodes U+00E9 as C3 A9'
        $bytes -contains 0xA9 | Should -BeTrue

        # A lone E9 with no C3 in front of it is the ISO-8859-1 encoding, and is what
        # the server rejects.
        $latin1 = [System.Text.Encoding]::GetEncoding('ISO-8859-1').GetBytes(
            ($([ordered]@{ relPath = $name }) | ConvertTo-Json -Compress))
        [System.Text.Encoding]::UTF8.GetString($bytes) | Should -Match 'Caf'
        (Compare-Object $bytes $latin1 -SyncWindow 0) | Should -Not -BeNullOrEmpty
    }

    It 'round-trips CJK and emoji through UTF-8' {
        foreach ($name in @('Sen to Chihiro no Kamikakushi.mkv', 'test.mkv')) {
            $bytes = ConvertTo-AgentJsonBody -Body ([ordered]@{ relPath = $name })
            ([System.Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json).relPath |
                Should -Be $name
        }
    }

    It 'says nothing for a null body rather than sending "null"' {
        ConvertTo-AgentJsonBody -Body $null | Should -BeNullOrEmpty
    }

    It 'honours a depth, so a deep report is not truncated' {
        $deep = [ordered]@{ a = [ordered]@{ b = [ordered]@{ c = [ordered]@{ d = 'leaf' } } } }
        $shallow = [System.Text.Encoding]::UTF8.GetString((ConvertTo-AgentJsonBody -Body $deep -Depth 2))
        $full = [System.Text.Encoding]::UTF8.GetString((ConvertTo-AgentJsonBody -Body $deep -Depth 8))
        $full | Should -Match 'leaf'
        $shallow | Should -Not -Be $full
    }
}

Describe 'Building an authenticated request' {
    BeforeAll {
        $script:Config = [ordered]@{
            ServerUrl = 'http://nas.local:8099/'; Token = 'tok-123'
            TimeoutSeconds = 60; SkipCertificateCheck = $false
        }
    }

    It 'posts bytes, so PowerShell never picks the encoding' {
        $request = New-AgentApiRequest -Config $script:Config -Path '/api/agent/jobs/1/batch' `
            -Body ([ordered]@{ relPath = 'Caf' + [char]0xE9 + '.mkv' })
        $request['Body'] -is [byte[]] | Should -BeTrue
    }

    It 'names the charset on the wire as well' {
        $request = New-AgentApiRequest -Config $script:Config -Path '/x' -Body ([ordered]@{ a = 1 })
        $request['ContentType'] | Should -Be 'application/json; charset=utf-8'
    }

    It 'carries the token and trims the trailing slash off the server url' {
        $request = New-AgentApiRequest -Config $script:Config -Path '/api/agent/dist' -Method 'Get'
        $request['Uri'] | Should -Be 'http://nas.local:8099/api/agent/dist'
        $request['Headers']['Authorization'] | Should -Be 'Bearer tok-123'
        $request['TimeoutSec'] | Should -Be 60
    }

    It 'sends no body at all for a GET' {
        $request = New-AgentApiRequest -Config $script:Config -Path '/api/agent/dist' -Method 'Get'
        $request.ContainsKey('Body') | Should -BeFalse
    }
}

<#
    A 400 that says only "(400) Bad Request" is what turned a one-line encoding bug into
    an afternoon. The server explains itself in the response body; Invoke-RestMethod
    throws it away.
#>
Describe 'Explaining a failed request' {
    It 'uses the body PowerShell 7 puts on the error record' {
        $record = [pscustomobject]@{
            ErrorDetails = [pscustomobject]@{ Message = '{"error":"invalid_batch"}' }
            Exception    = [pscustomobject]@{ Response = $null }
        }
        Get-AgentApiErrorDetail -ErrorRecord $record | Should -Match 'invalid_batch'
    }

    It 'returns nothing rather than throwing when there is no detail to be had' {
        Get-AgentApiErrorDetail -ErrorRecord $null | Should -BeNullOrEmpty
        $bare = [pscustomobject]@{ Exception = [pscustomobject]@{ Response = $null } }
        Get-AgentApiErrorDetail -ErrorRecord $bare | Should -BeNullOrEmpty
    }
}

<#
    A scheduled task run limit that would cut a catalog scan short.

    The installer set this to twice the report interval -- thirty minutes by default --
    and Task Scheduler duly killed the agent mid-batch on every real scan. A run is not
    one report: after reporting, the agent takes catalog work, and walking a 95 TB pool
    runs for hours. What ends it is the server closing the I/O window, which stops the
    walk at a directory boundary with a cursor. A clock knows nothing about that.
#>
Describe 'Judging a scheduled task run limit' {
    It 'flags the thirty minutes the installer used to set' {
        Test-AgentTaskTimeLimit -Value 'PT30M' | Should -BeTrue
    }

    It 'flags anything else short enough to interrupt a scan' {
        foreach ($limit in 'PT10M', 'PT1H', 'PT3H', 'PT150M') {
            Test-AgentTaskTimeLimit -Value $limit | Should -BeTrue -Because "$limit is shorter than a real scan"
        }
    }

    # PT0S is how Task Scheduler spells "no limit", which is what the agent wants.
    It 'is happy with no limit at all' {
        Test-AgentTaskTimeLimit -Value 'PT0S' | Should -BeFalse
        Test-AgentTaskTimeLimit -Value '' | Should -BeFalse
        Test-AgentTaskTimeLimit -Value $null | Should -BeFalse
    }

    # Somebody who sets twelve hours means it; that is not the mistake being repaired.
    It 'leaves a deliberately generous limit alone' {
        foreach ($limit in 'PT4H', 'PT8H', 'PT12H', 'P1D', 'PT72H') {
            Test-AgentTaskTimeLimit -Value $limit | Should -BeFalse -Because "$limit is long enough to be on purpose"
        }
    }

    It 'honours a different threshold' {
        Test-AgentTaskTimeLimit -Value 'PT6H' -MinimumHours 8 | Should -BeTrue
        Test-AgentTaskTimeLimit -Value 'PT6H' -MinimumHours 4 | Should -BeFalse
    }

    It 'does not throw on a value it cannot parse' {
        Test-AgentTaskTimeLimit -Value 'not a duration' | Should -BeFalse
    }
}

<#
    Reporting while a scan is running.

    A run is one process: report, then take catalog work that can run for hours. The
    task repeats every interval, but IgnoreNew drops those firings while the scan is
    still going -- so without a mid-scan report, a scan that takes all night means a
    whole night with no SMART data, which is most of what this tool is for.
#>
Describe 'Deciding when to report again mid-scan' {
    BeforeAll { $script:Noon = [DateTime]'2026-09-02T12:00:00' }

    It 'reports when nothing has been sent yet' {
        Test-AgentReportDue -LastReportAt $null -IntervalSeconds 900 | Should -BeTrue
    }

    It 'waits out the interval' {
        Test-AgentReportDue -LastReportAt $script:Noon -IntervalSeconds 900 `
            -Now $script:Noon.AddSeconds(300) | Should -BeFalse
    }

    It 'reports once the interval has passed' {
        Test-AgentReportDue -LastReportAt $script:Noon -IntervalSeconds 900 `
            -Now $script:Noon.AddSeconds(900) | Should -BeTrue
        Test-AgentReportDue -LastReportAt $script:Noon -IntervalSeconds 900 `
            -Now $script:Noon.AddHours(3) | Should -BeTrue
    }

    It 'follows the configured interval, not a fixed one' {
        Test-AgentReportDue -LastReportAt $script:Noon -IntervalSeconds 60 `
            -Now $script:Noon.AddSeconds(90) | Should -BeTrue
        Test-AgentReportDue -LastReportAt $script:Noon -IntervalSeconds 3600 `
            -Now $script:Noon.AddSeconds(90) | Should -BeFalse
    }

    # A nonsense interval must not turn every batch boundary into a full SMART sweep.
    It 'falls back to the default rather than reporting constantly' {
        Test-AgentReportDue -LastReportAt $script:Noon -IntervalSeconds 0 `
            -Now $script:Noon.AddSeconds(60) | Should -BeFalse
    }

    It 'does not report backwards if the clock moves' {
        Test-AgentReportDue -LastReportAt $script:Noon -IntervalSeconds 900 `
            -Now $script:Noon.AddHours(-1) | Should -BeFalse
    }
}

<#
    Bounding a batch by files, not by directories.

    BatchSize was only checked between directories, so a folder holding tens of
    thousands of files came back as one batch however small BatchSize was. The server
    then wrote that as a single transaction against a multi-gigabyte catalog and
    answered nothing else for tens of seconds -- and this is the endpoint the agent
    hits constantly, so it was not an occasional stall.
#>
Describe 'Bounding a catalog batch' {
    BeforeAll {
        $script:Root = Join-Path ([System.IO.Path]::GetTempPath()) ("batch-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path (Join-Path $script:Root 'Big') -Force | Out-Null
        # One directory with far more files than a batch should carry.
        foreach ($i in 1..50) {
            Set-Content -LiteralPath (Join-Path $script:Root "Big/file-$i.mkv") -Value 'x' -Encoding ascii
        }
    }
    AfterAll { Remove-Item -LiteralPath $script:Root -Recurse -Force -ErrorAction SilentlyContinue }

    It 'never returns more files than asked for' {
        $batch = Get-CatalogBatch -RootPath $script:Root -Worklist @('') -BatchSize 10
        $batch.files.Count | Should -BeLessOrEqual 10
    }

    It 'comes back to the rest of the directory rather than dropping it' {
        $worklist = @('')
        $seen = New-Object System.Collections.Generic.List[string]
        for ($round = 0; $round -lt 40; $round++) {
            $batch = Get-CatalogBatch -RootPath $script:Root -Worklist $worklist -BatchSize 10
            $batch.files.Count | Should -BeLessOrEqual 10
            foreach ($f in $batch.files) { $seen.Add($f.relPath) }
            $worklist = @($batch.worklist)
            if ($batch.finished) { break }
        }

        # Every file exactly once: no duplicates from resuming, none lost.
        $seen.Count | Should -Be 50
        ($seen | Sort-Object -Unique).Count | Should -Be 50
    }

    # The resume marker is encoded after a pipe, which Windows does not allow in a
    # name, so it can never be mistaken for part of a real path.
    It 'reaches the same set of files whatever the batch size' {
        $reference = $null
        foreach ($size in 1, 3, 7, 10, 50, 500) {
            $worklist = @('')
            $seen = New-Object System.Collections.Generic.List[string]
            for ($round = 0; $round -lt 200; $round++) {
                $batch = Get-CatalogBatch -RootPath $script:Root -Worklist $worklist -BatchSize $size
                foreach ($f in $batch.files) { $seen.Add($f.relPath) }
                $worklist = @($batch.worklist)
                if ($batch.finished) { break }
            }
            $sorted = @($seen | Sort-Object)
            if ($null -eq $reference) { $reference = $sorted }
            ($sorted -join '|') | Should -Be ($reference -join '|') -Because "batch size $size must see the same files"
            $sorted.Count | Should -Be 50
        }
    }
}
