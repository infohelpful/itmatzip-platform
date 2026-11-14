<#
.SYNOPSIS
  Issue / renew the Let's Encrypt certificate for local.itmatzip.com and build the bundle the agent downloads.

.DESCRIPTION
  local.itmatzip.com is a public DNS name pointing at 127.0.0.1 (Cloudflare, "DNS only"). The agent
  (go-agent/tls_local.go) serves https://local.itmatzip.com:19878 with a certificate it downloads from
  https://tools.itmatzip.com/agent-cert/bundle.json, so renewals never need a new agent build.

  Validation uses the DNS-01 challenge through the Cloudflare API (lego "cloudflare" provider).
  Requires lego v5 (https://github.com/go-acme/lego/releases): file lego_v5.x.x_windows_amd64.zip.

  API TOKEN
    Create a Cloudflare API token limited to the itmatzip.com zone with:
        Zone - DNS  - Edit
        Zone - Zone - Read
    Provide it through the CLOUDFLARE_DNS_API_TOKEN environment variable, or let this script ask for it.
    The token is used only for this process: it is never written to disk and never printed.
    NEVER paste the token into chat, git, or a script file.

  FIRST RUN / RENEWAL
    Run the script. It issues the certificate (or renews it when fewer than -RenewDays remain) and writes
    <WorkDir>\out\bundle.json. Upload that file to
        /home/infohelp/tools.itmatzip.com/agent-cert/bundle.json
    (cPanel File Manager or SFTP). The site deploy only copies files in; it never deletes this folder.
    Run it again every 30-60 days (certificates last 90 days). A weekly Windows Task Scheduler entry is enough.

  SECURITY
    * The bundle contains the PRIVATE KEY of local.itmatzip.com. Anyone can download it from the site, by
      design: every user's agent needs it. The certificate covers this one host name only.
    * Keep -WorkDir outside the git repository. Never commit bundle.json or the .lego folder.

.PARAMETER Email
  Contact e-mail registered with Let's Encrypt (expiry notices).
.PARAMETER WorkDir
  Where lego keeps its account and certificates.
.PARAMETER LegoExe
  Path to lego.exe (v5). Must be on PATH or given explicitly.
.PARAMETER RenewDays
  Renew when the certificate has fewer than this many days left.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Email,
  [string]$WorkDir = (Join-Path $env:LOCALAPPDATA 'itmatzip-local-cert'),
  [string]$LegoExe = 'lego',
  [int]$RenewDays = 30
)

$ErrorActionPreference = 'Stop'
$Domain = 'local.itmatzip.com'

if (-not (Get-Command $LegoExe -ErrorAction SilentlyContinue)) {
  throw "lego not found ('$LegoExe'). Download it from https://github.com/go-acme/lego/releases and pass -LegoExe <path>."
}

$repoRoot = (git rev-parse --show-toplevel 2>$null)
$resolvedWorkDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($WorkDir)
if ($repoRoot) {
  $repoRoot = $repoRoot.Replace('/', '\')
  if ($resolvedWorkDir.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "WorkDir must be outside the git repository ($repoRoot): it will hold a private key."
  }
}

# The token stays in this process only.
if (-not $env:CLOUDFLARE_DNS_API_TOKEN) {
  $secure = Read-Host -AsSecureString 'Cloudflare API token (Zone:DNS:Edit + Zone:Zone:Read for itmatzip.com)'
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $env:CLOUDFLARE_DNS_API_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if (-not $env:CLOUDFLARE_DNS_API_TOKEN) { throw 'No Cloudflare API token provided.' }

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$outDir = Join-Path $WorkDir 'out'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$crt = Join-Path $WorkDir "certificates\$Domain.crt"
$key = Join-Path $WorkDir "certificates\$Domain.key"
# lego v5: a single `run` command issues a missing certificate and renews one that is due.
# (v4 used global flags and a separate `renew` command; this script does not support v4.)
$legoArgs = @(
  'run', '--accept-tos', '--email', $Email, '--dns', 'cloudflare',
  '-d', $Domain, '--path', $WorkDir, '--renew-days', $RenewDays,
  # Skip the check against public recursive resolvers (1.1.1.1 ...). They cache the NXDOMAIN answer from
  # before the challenge record existed and keep returning it, so the check times out even though the
  # record is live. Let's Encrypt validates against the authoritative servers, which lego still checks.
  '--dns.propagation.disable-rns'
)

try {
  if (Test-Path $crt) {
    Write-Host "Existing certificate found - it is renewed only if fewer than $RenewDays days remain..."
  } else {
    Write-Host "No certificate yet - requesting one..."
  }
  & $LegoExe @legoArgs
  if ($LASTEXITCODE -ne 0) { throw "lego failed (exit $LASTEXITCODE). See the output above." }
} finally {
  Remove-Item Env:\CLOUDFLARE_DNS_API_TOKEN -ErrorAction SilentlyContinue
}

if (-not ((Test-Path $crt) -and (Test-Path $key))) { throw "Certificate files not found under $WorkDir\certificates" }

$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($crt)
$name = $cert.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::DnsName, $false)
if ($name -ne $Domain) { throw "Certificate is for '$name', expected '$Domain'." }
if ($cert.NotAfter -le (Get-Date)) { throw "Certificate already expired ($($cert.NotAfter))." }

$bundle = [ordered]@{
  hostname = $Domain
  cert_pem = [IO.File]::ReadAllText($crt)
  key_pem  = [IO.File]::ReadAllText($key)
}
$bundlePath = Join-Path $outDir 'bundle.json'
[IO.File]::WriteAllText($bundlePath, ($bundle | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "Certificate for $name valid until $($cert.NotAfter.ToString('yyyy-MM-dd HH:mm'))"
Write-Host "Bundle written: $bundlePath"
Write-Host "Upload it to:   /home/infohelp/tools.itmatzip.com/agent-cert/bundle.json  (https://tools.itmatzip.com/agent-cert/bundle.json)"
