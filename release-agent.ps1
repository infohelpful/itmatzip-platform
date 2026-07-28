#Requires -Version 5.1
<#
.SYNOPSIS
  ItMatZip 에이전트 원샷 릴리스: 버전 bump → MSI 빌드 → GitHub Release 업로드 → manifest → commit/push

.DESCRIPTION
  메모「ItMatZip 에이전트 버전 업데이트 방법.md」절차를 자동화합니다.

.EXAMPLE
  # 패치 버전 자동 증가 (1.5.0 → 1.5.1) 후 전체 릴리스
  .\release-agent.ps1 -Bump patch -ReleaseNotes "Python 3.12 engine + fixes"

.EXAMPLE
  # 버전 직접 지정
  .\release-agent.ps1 -Version 1.6.0 -ReleaseNotes "..."

.EXAMPLE
  # 빌드만 / 푸시 없이 확인
  .\release-agent.ps1 -Version 1.5.1 -SkipPush -SkipGitHubRelease
#>
param(
    [string]$Version = "",
    [ValidateSet("", "patch", "minor", "major")]
    [string]$Bump = "",
    [string]$ReleaseNotes = "",
    [string]$GitHubRepo = "infohelpful/itmatzip-platform",
    [string]$Branch = "main",
    [switch]$SkipBuild,
    [switch]$SkipGitHubRelease,
    [switch]$SkipManifest,
    [switch]$SkipPush,
    [switch]$SkipStopProcesses,
    [switch]$DryRun,
    [switch]$IncludeWorkingTree,
    [string]$Python = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Root = $PSScriptRoot
$VersionPy = Join-Path $Root "agent\version.py"
$ProductWxs = Join-Path $Root "go-agent\installer\product.wxs"
$BuildPs1 = Join-Path $Root "go-agent\installer\build.ps1"
$PublishPs1 = Join-Path $Root "publish-agent-release.ps1"
$MsiPath = Join-Path $Root "go-agent\dist\itmatzip-agent.msi"
$ManifestPath = Join-Path $Root "agent\agent-update-manifest.json"
$GoAgentDir = Join-Path $Root "go-agent"

function Write-Step([string]$Msg) {
    Write-Host ""
    Write-Host "==> $Msg" -ForegroundColor Cyan
}

function Read-AgentVersion {
    $raw = Get-Content $VersionPy -Raw -Encoding UTF8
    if ($raw -match 'AGENT_VERSION\s*=\s*"([^"]+)"') { return $Matches[1] }
    throw "AGENT_VERSION not found in $VersionPy"
}

function Bump-SemVer {
    param([string]$Current, [string]$Part)
    $bits = $Current.Split('.')
    if ($bits.Count -lt 3) { throw "Version must be x.y.z, got: $Current" }
    $major = [int]$bits[0]
    $minor = [int]$bits[1]
    $patch = [int]$bits[2]
    switch ($Part) {
        "major" { $major++; $minor = 0; $patch = 0 }
        "minor" { $minor++; $patch = 0 }
        "patch" { $patch++ }
        default { throw "Unknown bump: $Part" }
    }
    return "$major.$minor.$patch"
}

function Set-AgentVersionFiles {
    param([string]$NewVersion)
    if ($NewVersion -notmatch '^\d+\.\d+\.\d+$') {
        throw "Version must be x.y.z (got: $NewVersion)"
    }
    $wixVersion = "$NewVersion.0"

    $py = Get-Content $VersionPy -Raw -Encoding UTF8
    if ($py -notmatch 'AGENT_VERSION\s*=\s*"[^"]+"') {
        throw "Cannot patch AGENT_VERSION in $VersionPy"
    }
    $py2 = [regex]::Replace($py, 'AGENT_VERSION\s*=\s*"[^"]+"', "AGENT_VERSION = `"$NewVersion`"")
    if (-not $DryRun) {
        [System.IO.File]::WriteAllText($VersionPy, $py2, [System.Text.UTF8Encoding]::new($false))
    }

    $wxs = Get-Content $ProductWxs -Raw -Encoding UTF8
    if ($wxs -notmatch 'ProductVersion\s*=\s*"[^"]+"') {
        throw "Cannot patch ProductVersion in $ProductWxs"
    }
    $wxs2 = [regex]::Replace($wxs, 'ProductVersion\s*=\s*"[^"]+"', "ProductVersion = `"$wixVersion`"")
    if (-not $DryRun) {
        [System.IO.File]::WriteAllText($ProductWxs, $wxs2, [System.Text.UTF8Encoding]::new($false))
    }

    Write-Host "version.py  → $NewVersion"
    Write-Host "product.wxs → $wixVersion"
}

function Stop-AgentZombies {
    Write-Step "Stopping agent / port holders (best-effort)"
    try { Stop-Service ItMatZipAgent -Force -ErrorAction SilentlyContinue } catch {}
    Get-Process itmatzip-agent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    foreach ($port in 19876, 19877, 19878, 50051, 50151) {
        Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
            ForEach-Object {
                try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch {}
            }
    }
}

function Assert-GhReady {
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $gh) { throw "gh CLI not found. Install: https://cli.github.com/" }
    $status = & gh auth status 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "gh not authenticated. Run: gh auth login`n$status" }
}

function Resolve-BuildPython {
    param([string]$Preferred)
    if ($Preferred -and (Test-Path $Preferred)) { return (Resolve-Path $Preferred).Path }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"),
        (Join-Path $env:ProgramFiles "Python312\python.exe")
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($pyLauncher) {
        $exe = & py -3.12 -c "import sys; print(sys.executable)" 2>$null
        if ($exe -and (Test-Path $exe.Trim())) { return $exe.Trim() }
    }
    return "python"
}

# --- resolve version ---
$current = Read-AgentVersion
if ($Version -and $Bump) {
    throw "Use either -Version or -Bump, not both."
}
if (-not $Version) {
    if (-not $Bump) { $Bump = "patch" }
    $Version = Bump-SemVer -Current $current -Part $Bump
}

if (-not $ReleaseNotes) {
    $ReleaseNotes = "ItMatZip Agent $Version"
}

$tag = "v$Version"
$downloadUrl = "https://github.com/$GitHubRepo/releases/download/$tag/itmatzip-agent.msi"

$PythonExe = Resolve-BuildPython -Preferred $Python
Write-Host "========================================" -ForegroundColor Green
Write-Host " ItMatZip agent release"
Write-Host " current : $current"
Write-Host " target  : $Version  (tag $tag)"
Write-Host " python  : $PythonExe"
Write-Host " notes   : $ReleaseNotes"
Write-Host " dry-run : $DryRun"
Write-Host "========================================" -ForegroundColor Green

if ($DryRun) {
    Write-Host "[DryRun] Would bump versions, build MSI, gh release, manifest, git push." -ForegroundColor Yellow
    exit 0
}

# --- 1) bump versions ---
Write-Step "1/6 Bump version files"
Set-AgentVersionFiles -NewVersion $Version

# --- 2) stop processes ---
if (-not $SkipStopProcesses) {
    Stop-AgentZombies
} else {
    Write-Host "Skip stop processes"
}

# --- 3) build MSI ---
if (-not $SkipBuild) {
    Write-Step "2/6 Build MSI (UseEmbeddable) — may take several minutes"
    Push-Location $GoAgentDir
    try {
        & go build -o itmatzip-agent.exe .
        if ($LASTEXITCODE -ne 0) { throw "go build failed ($LASTEXITCODE)" }
        & powershell -ExecutionPolicy Bypass -File $BuildPs1 -UseEmbeddable -Python $PythonExe
        if ($LASTEXITCODE -ne 0) { throw "installer\build.ps1 failed ($LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
} else {
    Write-Step "2/6 Build skipped"
}

if (-not (Test-Path $MsiPath)) {
    throw "MSI not found: $MsiPath — build first or omit -SkipBuild"
}
$msiSize = (Get-Item $MsiPath).Length
Write-Host "MSI OK: $MsiPath ($([math]::Round($msiSize/1MB, 1)) MB)" -ForegroundColor Green

# --- 4) GitHub Release ---
if (-not $SkipGitHubRelease) {
    Write-Step "3/6 GitHub Release $tag + upload MSI"
    Assert-GhReady

    $releaseExists = $false
    try {
        & gh release view $tag --repo $GitHubRepo 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { $releaseExists = $true }
    } catch {
        $releaseExists = $false
    }

    if ($releaseExists) {
        Write-Host "Release $tag already exists — uploading/replacing asset..." -ForegroundColor Yellow
        & gh release upload $tag $MsiPath --repo $GitHubRepo --clobber
        if ($LASTEXITCODE -ne 0) { throw "gh release upload failed" }
    } else {
        & gh release create $tag $MsiPath `
            --repo $GitHubRepo `
            --title "ItMatZip Agent $Version" `
            --notes $ReleaseNotes
        if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }
    }
    Write-Host "Release URL: https://github.com/$GitHubRepo/releases/tag/$tag" -ForegroundColor Green
} else {
    Write-Step "3/6 GitHub Release skipped"
}

# --- 5) manifest ---
if (-not $SkipManifest) {
    Write-Step "4/6 Update agent-update-manifest.json"
    & powershell -ExecutionPolicy Bypass -File $PublishPs1 `
        -PackageType msi `
        -Version $Version `
        -MsiPath $MsiPath `
        -DownloadUrl $downloadUrl `
        -ReleaseNotes $ReleaseNotes
    if ($LASTEXITCODE -ne 0) { throw "publish-agent-release.ps1 failed" }
} else {
    Write-Step "4/6 Manifest skipped"
}

# --- 6) git commit + push ---
if (-not $SkipPush) {
    Write-Step "5/6 Git commit"
    Push-Location $Root
    try {
        $paths = @(
            "agent/version.py",
            "agent/agent-update-manifest.json",
            "go-agent/installer/product.wxs",
            # 설치 팝업 버튼명(에이전트 다운로드 vX.Y.Z) — assets 우선 조회
            "web-ui/tools/assets/agent-update-manifest.json",
            "web-ui/tools/common/agent-install-ui.js"
        )
        if ($IncludeWorkingTree) {
            # 3.12 마이그레이션 등 관련 변경을 같이 올릴 때
            $paths += @(
                "agent/",
                "go-agent/",
                "start-agent.ps1",
                "PLATFORM.md",
                "README.md",
                ".cursor/rules/per-tool-runtime.mdc",
                "web-ui/tools/image-enhancer/IMAGE-ENHANCER.MD",
                "release-agent.ps1",
                "publish-agent-release.ps1"
            )
        }

        foreach ($p in $paths) {
            $full = Join-Path $Root $p
            if (Test-Path $full) {
                # git may write CRLF warnings to stderr; do not treat as fatal under $ErrorActionPreference Stop
                cmd /c "git add -- `"$p`" 2>nul"
            }
        }

        $staged = git diff --cached --name-only
        if (-not $staged) {
            Write-Host "Nothing staged — skipping commit" -ForegroundColor Yellow
        } else {
            $msg = @"
Release agent $Version

$ReleaseNotes
"@
            git commit -m $msg
            if ($LASTEXITCODE -ne 0) { throw "git commit failed" }

            Write-Step "6/6 git push origin $Branch"
            git push origin $Branch
            if ($LASTEXITCODE -ne 0) { throw "git push failed" }
        }
    } finally {
        Pop-Location
    }
} else {
    Write-Step "5–6/6 Git commit/push skipped"
    Write-Host "Manual:" -ForegroundColor Yellow
    Write-Host "  git add agent/version.py agent/agent-update-manifest.json go-agent/installer/product.wxs web-ui/tools/assets/agent-update-manifest.json web-ui/tools/common/agent-install-ui.js"
    Write-Host "  git commit -m `"Release agent $Version`""
    Write-Host "  git push origin $Branch"
}

Write-Host ""
Write-Host "Done. Agent $Version released." -ForegroundColor Green
Write-Host "  MSI:      $downloadUrl"
Write-Host "  Manifest: https://raw.githubusercontent.com/$GitHubRepo/$Branch/agent/agent-update-manifest.json"
Write-Host "  Health:   Invoke-RestMethod http://127.0.0.1:19876/health"
