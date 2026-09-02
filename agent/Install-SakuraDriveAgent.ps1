<#
.SYNOPSIS
    Install the SakuraDrive agent as a Windows scheduled task.

.DESCRIPTION
    Copies the agent to a stable location, writes its configuration and registers a
    scheduled task that runs it as SYSTEM every IntervalSeconds. Running as SYSTEM
    matters: reading SMART data and querying DrivePool both need administrative rights,
    and the task must survive the operator logging out.

    Re-running the script updates an existing installation in place.

.PARAMETER ServerUrl
    Base URL of the SakuraDrive web interface, for example http://nas.local:8080

.PARAMETER Token
    Agent token created under Settings then Agents in the web interface.

.PARAMETER InstallPath
    Where the agent lives. Defaults to C:\Program Files\SakuraDrive Agent.

.PARAMETER IntervalMinutes
    How often to report. 15 minutes is a sensible default: often enough to catch a
    drive going bad, rare enough to be invisible.

.PARAMETER SmartctlPath
    Full path to smartctl.exe. Leave blank and the agent looks in the usual places.

.PARAMETER DpcmdPath
    Full path to StableBit DrivePool's dpcmd.exe. Blank means search.

.PARAMETER RxpccPath
    Full path to PrimoCache's rxpcc.exe. Blank means search.

.PARAMETER MaxRunHours
    Stop the task if a run exceeds this many hours. 0, the default, means no limit:
    a catalog scan is ended by the server closing the I/O window, not by a clock, and
    a limit short enough to matter cuts the scan off mid-batch.

.PARAMETER FirstRunTimeoutSeconds
    How long to wait for the confirmation run before reporting that it is still going.
    The first pass reads SMART for every disk, so a large array takes minutes.

.PARAMETER KeepConfig
    Re-register the task without touching agent.config.json. Use this after editing the
    configuration by hand, so an upgrade does not overwrite it.

.PARAMETER Uninstall
    Remove the scheduled task and the installed files.

.EXAMPLE
    .\Install-SakuraDriveAgent.ps1 -ServerUrl http://nas.local:8080 -Token abc123

.EXAMPLE
    .\Install-SakuraDriveAgent.ps1 -Uninstall
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $ServerUrl,
    [string] $Token,
    [string] $InstallPath = 'C:\Program Files\SakuraDrive Agent',
    [int]    $IntervalMinutes = 15,
    [int]    $FirstRunTimeoutSeconds = 120,
    [int]    $MaxRunHours = 0,
    [string] $TaskName = 'SakuraDrive Agent',
    [string] $SmartctlPath = '',
    [string] $DpcmdPath = '',
    [string] $RxpccPath = '',
    [switch] $KeepConfig,
    [switch] $Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
    throw 'Run this from an elevated PowerShell prompt: reading SMART data and querying DrivePool both require administrative rights.'
}

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        if ($PSCmdlet.ShouldProcess($TaskName, 'Unregister scheduled task')) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Host "Removed the scheduled task '$TaskName'."
        }
    }
    else {
        Write-Host "No scheduled task named '$TaskName' was found."
    }

    if (Test-Path -LiteralPath $InstallPath) {
        if ($PSCmdlet.ShouldProcess($InstallPath, 'Remove installed files')) {
            Remove-Item -LiteralPath $InstallPath -Recurse -Force
            Write-Host "Removed $InstallPath."
        }
    }
    Write-Host 'Uninstalled. The token remains valid until you revoke it in the web interface.'
    Write-Host 'The catalog is untouched: removing the agent does not delete what it recorded.'
    return
}

# Hoisted so the confirmation run at the end can name the log even when the install
# block below was skipped, as -WhatIf skips it.
$logDirectory = 'C:\ProgramData\SakuraDrive'
$logPath = Join-Path $logDirectory 'agent.log'

if (-not $ServerUrl) { throw 'ServerUrl is required, for example -ServerUrl http://nas.local:8080' }
if (-not $Token) { throw 'Token is required. Create one under Settings then Agents in the web interface.' }
if ($IntervalMinutes -lt 1) { throw 'IntervalMinutes must be at least 1.' }

# ---------------------------------------------------------------- install files

if ($PSCmdlet.ShouldProcess($InstallPath, 'Install agent files')) {
    New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null

    # Import from beside this script, not from the installation: the list of files to
    # install has to come from the version being installed rather than the one being
    # replaced, or a new file would never arrive on a host that already has an agent.
    Import-Module (Join-Path $PSScriptRoot 'SakuraDrive.Agent.psm1') -Force

    # The whole distribution, including the uninstaller and the bootstrap script: both
    # have to still be there when the folder this was run from is long gone.
    foreach ($file in Get-AgentDistributionFile) {
        $relative = $file.Replace('/', '\')
        $source = Join-Path $PSScriptRoot $relative
        if (-not (Test-Path -LiteralPath $source)) { throw "Missing $file next to this installer." }
        $destination = Join-Path $InstallPath $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }

    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

    $configPath = Join-Path $InstallPath 'agent.config.json'

    # Start from the agent's own defaults rather than a second list maintained here.
    # A hand-written copy drifts: this one had lost RxpccPath and CollectCatalogJobs,
    # so those keys were absent from every installed configuration and nobody could
    # tell they were settable.
    $existing = $null
    if ($KeepConfig -and (Test-Path -LiteralPath $configPath)) {
        $existing = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        Write-Host 'Keeping the existing agent.config.json; only new keys are added.'
    }

    $configuration = Merge-AgentConfig -UserConfig $existing
    # Anything passed on the command line wins; anything left blank keeps what was
    # there, so re-running an upgrade does not quietly reset a tuned installation.
    if ($ServerUrl) { $configuration.ServerUrl = $ServerUrl.TrimEnd('/') }
    if ($Token) { $configuration.Token = $Token }
    if ($PSBoundParameters.ContainsKey('IntervalMinutes')) {
        $configuration.IntervalSeconds = $IntervalMinutes * 60
    }
    foreach ($tool in 'SmartctlPath', 'DpcmdPath', 'RxpccPath') {
        if ($PSBoundParameters.ContainsKey($tool) -and $PSBoundParameters[$tool]) {
            $configuration[$tool] = $PSBoundParameters[$tool]
        }
    }
    if (-not $configuration.LogPath) { $configuration.LogPath = $logPath }
    $logPath = $configuration.LogPath

    # Fail here rather than fifteen minutes later in a log nobody is watching.
    $problems = Test-AgentConfig -Config $configuration
    if ($problems.Count -gt 0) {
        throw ("The configuration is not usable:`n  " + ($problems -join "`n  "))
    }

    # A tool path that was given but does not exist is a typo, and the agent would
    # silently fall back to searching. Say so now.
    foreach ($tool in 'SmartctlPath', 'DpcmdPath', 'RxpccPath') {
        $value = $configuration[$tool]
        if ($value -and -not (Test-Path -LiteralPath $value)) {
            Write-Warning "$tool is set to '$value', which does not exist. The agent will search the usual locations instead."
        }
    }

    $configuration | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding utf8

    # The token is a credential: keep the configuration readable only by administrators
    # and SYSTEM, not by every local user.
    $acl = Get-Acl -LiteralPath $configPath
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($account in @('NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')) {
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                    $account, 'FullControl', 'Allow')))
    }
    Set-Acl -LiteralPath $configPath -AclObject $acl

    # An installation whose files were replaced by hand carries a stale version here.
    # Clearing it makes the agent re-check against the server on its first run instead
    # of believing a version it is no longer running.
    $statePath = Join-Path $InstallPath 'update-state.json'
    if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force }

    Write-Host "Installed the agent into $InstallPath."
    Write-Host "Configuration: $configPath"
    Write-Host "Uninstall:     $(Join-Path $InstallPath 'Uninstall-SakuraDriveAgent.ps1')"
    Write-Host '  Edit it and re-run with -KeepConfig to keep your changes across upgrades.'
    foreach ($tool in 'SmartctlPath', 'DpcmdPath', 'RxpccPath') {
        $value = $configuration[$tool]
        Write-Host ("  {0,-14} {1}" -f $tool, $(if ($value) { $value } else { '(search the usual locations)' }))
    }
}

# ------------------------------------------------------------- scheduled task

if ($PSCmdlet.ShouldProcess($TaskName, 'Register scheduled task')) {
    $scriptPath = Join-Path $InstallPath 'SakuraDriveAgent.ps1'
    $powershell = if (Get-Command pwsh.exe -ErrorAction SilentlyContinue) { 'pwsh.exe' } else { 'powershell.exe' }

    $action = New-ScheduledTaskAction -Execute $powershell `
        -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`"" `
        -WorkingDirectory $InstallPath

    # Two triggers: one at boot so monitoring resumes after a restart without waiting
    # for the first interval, and a repeating one for the steady state.
    # Two triggers, because one is not enough: AtStartup means monitoring resumes after
    # a reboot without waiting out the interval, and the repeating trigger covers the
    # steady state. The task runs as SYSTEM, so neither depends on anyone being logged
    # in - it survives a reboot and a sign-out alike.
    $atStartup = New-ScheduledTaskTrigger -AtStartup
    $atStartup.Delay = 'PT2M'
    $repeating = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

    # StartWhenAvailable catches up a run the machine slept through; RestartCount
    # retries a run that failed outright rather than leaving monitoring dark until the
    # next interval; IgnoreNew stops a slow run from stacking on top of itself.
    #
    # No execution time limit, and that is deliberate. A run is not one report: after
    # reporting, the agent takes catalog work, and walking a 95 TB pool runs for hours.
    # What ends it is the server closing the I/O window, which arrives in the reply to a
    # batch and stops the walk at a directory boundary with a cursor. A clock in Task
    # Scheduler knows nothing about that window and kills the process mid-batch instead.
    # This used to be IntervalMinutes * 2 -- thirty minutes -- which cut every real scan
    # short. TimeSpan::Zero is how Task Scheduler spells "no limit".
    $runLimit = if ($MaxRunHours -gt 0) { New-TimeSpan -Hours $MaxRunHours } else { [TimeSpan]::Zero }
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) `
        -ExecutionTimeLimit $runLimit

    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }

    Register-ScheduledTask -TaskName $TaskName `
        -Description 'Collects SMART, DrivePool and performance data for SakuraDrive.' `
        -Action $action -Trigger @($atStartup, $repeating) -Principal $principal -Settings $settings | Out-Null

    Write-Host "Registered the scheduled task '$TaskName' to run every $IntervalMinutes minutes as SYSTEM."
}

# ------------------------------------------------------------------ first run

Write-Host ''
if (-not $PSCmdlet.ShouldProcess($TaskName, 'Run once to confirm it reaches the server')) { return }

Write-Host 'Running once now to confirm the agent can reach the server...'
Start-ScheduledTask -TaskName $TaskName

# Poll rather than sleeping a fixed five seconds. The first pass reads SMART for every
# disk and probes every volume with dpcmd, which on a large array takes minutes -- so a
# fixed wait reported "still running" (267009) as though it were a failure code, right
# next to the words "0 means success".
$deadline = (Get-Date).AddSeconds($FirstRunTimeoutSeconds)
do {
    Start-Sleep -Seconds 3
    $registered = Get-ScheduledTask -TaskName $TaskName
} while ($registered.State -eq 'Running' -and (Get-Date) -lt $deadline)

$task = Get-ScheduledTaskInfo -TaskName $TaskName
$outcome = Get-ScheduledTaskResultText -Code $task.LastTaskResult

if ($registered.State -eq 'Running') {
    Write-Host "First run: still going after $FirstRunTimeoutSeconds seconds, which is normal on a large array."
    Write-Host "  Watch it: Get-Content '$logPath' -Tail 20 -Wait"
}
elseif ($outcome.ok) {
    Write-Host "First run: $($outcome.text)"
}
else {
    Write-Warning "First run: $($outcome.text)"
    Write-Warning "  The log is $logPath"
}

Write-Host "Runs as: $($registered.Principal.UserId) ($($registered.Principal.RunLevel))"
Write-Host "Triggers: $($registered.Triggers.Count) (one at boot, one repeating every $IntervalMinutes minutes)"
Write-Host ("Run time limit: {0}" -f $(if ($MaxRunHours -gt 0) { "$MaxRunHours hours" } else { 'none - a catalog scan runs until the I/O window closes' }))
Write-Host "Survives reboot and sign-out: yes - the task runs as SYSTEM and starts at boot."
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Open the SakuraDrive web interface and check Settings then Agents for this host.'
Write-Host '     The agent keeps itself current from there: deploying a new server updates this host.'
Write-Host '  2. For full SMART attributes, install smartmontools: https://www.smartmontools.org'
Write-Host "  3. Logs are written to C:\ProgramData\SakuraDrive\agent.log"
