<#
.SYNOPSIS
    Install the SakuraDrive agent by fetching it from the SakuraDrive server.

.DESCRIPTION
    The server ships the agent. This script is the only file an operator downloads by
    hand: it asks the server for the current manifest, downloads every file, checks each
    one against the SHA-256 in the manifest, parses the PowerShell before running any of
    it, and only then hands over to the installer.

    Nothing is trusted because it came from the right URL. A truncated download, a proxy
    that rewrote the body, a file that will not parse - each of those stops the install
    with a message rather than leaving a half-installed agent on the host.

    Re-running it is how an agent is repaired: it reinstalls from the server, and
    -KeepConfig leaves agent.config.json alone.

.PARAMETER ServerUrl
    Base URL of the SakuraDrive web interface, for example http://nas.local:8080

.PARAMETER Token
    Agent token created under Settings then Agents in the web interface.

.PARAMETER InstallPath
    Where the agent lives. Defaults to C:\Program Files\SakuraDrive Agent.

.PARAMETER IntervalMinutes
    How often the agent reports.

.PARAMETER KeepConfig
    Leave an existing agent.config.json alone; only new keys are added.

.PARAMETER SkipCertificateCheck
    Accept a self-signed certificate. Only for a trusted LAN.

.EXAMPLE
    .\Bootstrap-SakuraDriveAgent.ps1 -ServerUrl http://nas.local:8080 -Token abc123
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $ServerUrl,
    [Parameter(Mandatory)] [string] $Token,
    [string] $InstallPath = 'C:\Program Files\SakuraDrive Agent',
    [int]    $IntervalMinutes = 15,
    [string] $TaskName = 'SakuraDrive Agent',
    [string] $SmartctlPath = '',
    [string] $DpcmdPath = '',
    [string] $RxpccPath = '',
    [switch] $KeepConfig,
    [switch] $SkipCertificateCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
    throw 'Run this from an elevated PowerShell prompt: the agent reads SMART data and queries DrivePool, both of which need administrative rights.'
}

$base = $ServerUrl.TrimEnd('/')

# TLS 1.2 is not the default in Windows PowerShell 5.1, which is what ships with Windows
# Server. Without this an https server is simply unreachable, with an error that says
# nothing about why.
try {
    [System.Net.ServicePointManager]::SecurityProtocol =
    [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
}
catch { }

$previousCallback = $null
if ($SkipCertificateCheck) {
    $previousCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
}

function Invoke-Server {
    param([string] $Path, [string] $OutFile)

    $parameters = @{
        Uri             = "$base$Path"
        Headers         = @{ Authorization = "Bearer $Token" }
        TimeoutSec      = 120
        UseBasicParsing = $true
    }
    if ($OutFile) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $OutFile) -Force | Out-Null
        $parameters['OutFile'] = $OutFile
        Invoke-WebRequest @parameters | Out-Null
        return
    }
    Invoke-RestMethod @parameters
}

try {
    Write-Host "Asking $base what the agent should be..."
    try {
        $manifest = Invoke-Server -Path '/api/agent/dist'
    }
    catch {
        throw "Could not reach $base : $($_.Exception.Message)`nCheck the URL, that the token is current, and that the host can reach the server."
    }

    if ($null -eq $manifest -or -not $manifest.PSObject.Properties['files'] -or @($manifest.files).Count -eq 0) {
        throw 'The server did not offer any agent files. It may have been built without the agent source.'
    }

    Write-Host "Version $($manifest.version) - $(@($manifest.files).Count) files."

    $staging = Join-Path ([System.IO.Path]::GetTempPath()) ("sakuradrive-agent-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging -Force | Out-Null

    foreach ($file in @($manifest.files)) {
        $relative = ([string]$file.path).Replace('/', '\')
        $destination = Join-Path $staging $relative
        Invoke-Server -Path ("/api/agent/dist/file?path=" + [System.Uri]::EscapeDataString([string]$file.path)) `
            -OutFile $destination

        # Verify before anything is imported or run. This is the check that makes it
        # safe to execute code that arrived over the network.
        $actual = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne ([string]$file.sha256).ToLowerInvariant()) {
            throw "$($file.path) does not match the server's hash. Nothing was installed."
        }
    }

    # The module has now been hash-checked, so it can be trusted to check the rest.
    Import-Module (Join-Path $staging 'SakuraDrive.Agent.psm1') -Force
    $problems = Test-AgentDistribution -Directory $staging -Manifest $manifest
    if ($problems.Count -gt 0) {
        throw ("The downloaded agent is not usable, so nothing was installed:`n  " + ($problems -join "`n  "))
    }

    Write-Host 'Verified. Installing...'
    Write-Host ''

    $installerArguments = @{
        ServerUrl       = $base
        Token           = $Token
        InstallPath     = $InstallPath
        IntervalMinutes = $IntervalMinutes
        TaskName        = $TaskName
    }
    foreach ($tool in 'SmartctlPath', 'DpcmdPath', 'RxpccPath') {
        if ($PSBoundParameters.ContainsKey($tool) -and $PSBoundParameters[$tool]) {
            $installerArguments[$tool] = $PSBoundParameters[$tool]
        }
    }
    if ($KeepConfig) { $installerArguments['KeepConfig'] = $true }

    & (Join-Path $staging 'Install-SakuraDriveAgent.ps1') @installerArguments

    # Record what was installed, so the agent knows it is current and does not download
    # the same files again on its first run.
    Write-AgentUpdateState -InstallPath $InstallPath -State (New-AgentUpdateState `
            -Version ([string]$manifest.version) `
            -AgentVersion ([string]$manifest.agentVersion) -Stage 'confirmed') | Out-Null

    Write-Host ''
    Write-Host "The agent updates itself from $base from now on: deploying a new server updates every host."
}
finally {
    if ($SkipCertificateCheck) {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $previousCallback
    }
    if ((Test-Path variable:staging) -and $staging -and (Test-Path -LiteralPath $staging)) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}
