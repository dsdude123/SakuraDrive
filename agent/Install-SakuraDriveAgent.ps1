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
    [string] $TaskName = 'SakuraDrive Agent',
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
    return
}

if (-not $ServerUrl) { throw 'ServerUrl is required, for example -ServerUrl http://nas.local:8080' }
if (-not $Token) { throw 'Token is required. Create one under Settings then Agents in the web interface.' }
if ($IntervalMinutes -lt 1) { throw 'IntervalMinutes must be at least 1.' }

# ---------------------------------------------------------------- install files

if ($PSCmdlet.ShouldProcess($InstallPath, 'Install agent files')) {
    New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null

    foreach ($file in @('SakuraDriveAgent.ps1', 'SakuraDrive.Agent.psm1')) {
        $source = Join-Path $PSScriptRoot $file
        if (-not (Test-Path -LiteralPath $source)) { throw "Missing $file next to this installer." }
        Copy-Item -LiteralPath $source -Destination (Join-Path $InstallPath $file) -Force
    }

    $logDirectory = 'C:\ProgramData\SakuraDrive'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

    $configuration = [ordered]@{
        ServerUrl            = $ServerUrl.TrimEnd('/')
        Token                = $Token
        IntervalSeconds      = $IntervalMinutes * 60
        SmartctlPath         = ''
        DpcmdPath            = ''
        DuplicationDepth     = 3
        PerformanceSamples   = 3
        CollectSmart         = $true
        CollectPerformance   = $true
        CollectDrivePool     = $true
        CollectPrimoCache    = $true
        SkipCertificateCheck = $false
        TimeoutSeconds       = 120
        LogPath              = (Join-Path $logDirectory 'agent.log')
    }

    $configPath = Join-Path $InstallPath 'agent.config.json'
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

    Write-Host "Installed the agent into $InstallPath."
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
    # in — it survives a reboot and a sign-out alike.
    $atStartup = New-ScheduledTaskTrigger -AtStartup
    $atStartup.Delay = 'PT2M'
    $repeating = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

    # StartWhenAvailable catches up a run the machine slept through; RestartCount
    # retries a run that failed outright rather than leaving monitoring dark until the
    # next interval; IgnoreNew stops a slow run from stacking on top of itself.
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) `
        -ExecutionTimeLimit (New-TimeSpan -Minutes ([Math]::Max(10, $IntervalMinutes * 2)))

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
Write-Host 'Running once now to confirm the agent can reach the server...'
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 5

$task = Get-ScheduledTaskInfo -TaskName $TaskName
$registered = Get-ScheduledTask -TaskName $TaskName
Write-Host "Last result: $($task.LastTaskResult) (0 means success)"
Write-Host "Runs as: $($registered.Principal.UserId) ($($registered.Principal.RunLevel))"
Write-Host "Triggers: $($registered.Triggers.Count) (one at boot, one repeating every $IntervalMinutes minutes)"
Write-Host "Survives reboot and sign-out: yes - the task runs as SYSTEM and starts at boot."
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Open the SakuraDrive web interface and check Settings then Agents for this host.'
Write-Host '  2. For full SMART attributes, install smartmontools: https://www.smartmontools.org'
Write-Host "  3. Logs are written to C:\ProgramData\SakuraDrive\agent.log"
