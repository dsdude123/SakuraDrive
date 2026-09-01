<#
.SYNOPSIS
    Remove the SakuraDrive agent from this host.

.DESCRIPTION
    Stops and unregisters the scheduled task, then removes the installed files. Self
    contained on purpose: it is installed alongside the agent so it is still there when
    the folder the installer came from is long gone.

    Nothing on the server is touched. The agent's token stays valid until it is revoked
    under Settings then Agents, and the catalog this agent populated is left alone --
    deleting the record of what was on a disk is never a side effect of removing the
    thing that read it.

.PARAMETER InstallPath
    Where the agent lives. Defaults to C:\Program Files\SakuraDrive Agent.

.PARAMETER TaskName
    Scheduled task to unregister. Defaults to 'SakuraDrive Agent'.

.PARAMETER KeepLogs
    Leave C:\ProgramData\SakuraDrive in place. Logs are kept by default; pass
    -KeepLogs:$false to remove them too.

.EXAMPLE
    .\Uninstall-SakuraDriveAgent.ps1

.EXAMPLE
    .\Uninstall-SakuraDriveAgent.ps1 -WhatIf
    Show what would be removed without removing anything.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $InstallPath = 'C:\Program Files\SakuraDrive Agent',
    [string] $TaskName = 'SakuraDrive Agent',
    [string] $LogDirectory = 'C:\ProgramData\SakuraDrive',
    [switch] $KeepLogs = $true
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
    throw 'Run this from an elevated PowerShell prompt: the scheduled task runs as SYSTEM and only an administrator can remove it.'
}

$removed = 0

# Stop it first. Unregistering a task mid-run leaves the process orphaned, and this one
# may be part-way through a catalog scan.
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    if ($task.State -eq 'Running' -and $PSCmdlet.ShouldProcess($TaskName, 'Stop the running task')) {
        try {
            Stop-ScheduledTask -TaskName $TaskName
            Write-Host "Stopped '$TaskName'."
        }
        catch {
            Write-Warning "Could not stop '$TaskName': $($_.Exception.Message)"
        }
    }
    if ($PSCmdlet.ShouldProcess($TaskName, 'Unregister scheduled task')) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed the scheduled task '$TaskName'."
        $removed++
    }
}
else {
    Write-Host "No scheduled task named '$TaskName' was found."
}

if (Test-Path -LiteralPath $InstallPath) {
    if ($PSCmdlet.ShouldProcess($InstallPath, 'Remove installed files')) {
        # The configuration holds the agent token, so it goes with everything else.
        Remove-Item -LiteralPath $InstallPath -Recurse -Force
        Write-Host "Removed $InstallPath."
        $removed++
    }
}
else {
    Write-Host "$InstallPath does not exist."
}

if (Test-Path -LiteralPath $LogDirectory) {
    if ($KeepLogs) {
        Write-Host "Left $LogDirectory in place. Pass -KeepLogs:`$false to remove the logs too."
    }
    elseif ($PSCmdlet.ShouldProcess($LogDirectory, 'Remove logs')) {
        Remove-Item -LiteralPath $LogDirectory -Recurse -Force
        Write-Host "Removed $LogDirectory."
        $removed++
    }
}

if ($removed -eq 0) {
    Write-Host 'Nothing to remove: the agent does not appear to be installed here.'
}
else {
    Write-Host ''
    Write-Host 'Done. Two things this deliberately did not do:' -ForegroundColor Cyan
    Write-Host '  - The agent token is still valid. Revoke it under Settings -> Agents.'
    Write-Host '  - The catalog is untouched. Removing the thing that read a disk should'
    Write-Host '    never delete the record of what was on it.'
}
