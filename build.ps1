# Builds SoloSend. See BUILD.md.
#
#   powershell -ExecutionPolicy Bypass -File build.ps1            # the .xpi
#   powershell -ExecutionPolicy Bypass -File build.ps1 -Source    # .xpi + source archive
#
# There is no compilation step: the add-on is packaged verbatim from the source
# paths listed in $Shipped.
#
# Archives are written directly through System.IO.Compression rather than with
# Compress-Archive, for two reasons:
#   * Windows PowerShell 5.1's Compress-Archive writes backslash entry names,
#     which are invalid in a ZIP and can stop Thunderbird loading the .xpi.
#   * Fixing the entry timestamps and order makes repeated builds byte-for-byte
#     identical on a given PowerShell edition.

#Requires -Version 5.1
[CmdletBinding()]
param(
    # Also produce dist/solosend-<version>-source.zip for an ATN source-code request.
    [switch] $Source
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$dist = Join-Path $root 'dist'

# The only paths that go into the .xpi. manifest.json must land at the root.
# LICENSE ships too: MIT requires the notice to accompany every copy.
$Shipped = 'manifest.json', 'background.js', 'dialog', 'icons', 'LICENSE'

# Everything a reviewer needs to rebuild the .xpi and regenerate the icon PNGs,
# plus test fixtures.
$SourceOnly = 'README.md', 'BUILD.md', 'build.ps1', 'build.sh', '.gitignore', 'test-files', 'tools'

# Fixed entry timestamp; keeps the output reproducible. ZIP cannot store dates
# before 1980, so this is an arbitrary valid constant, not a real build time.
$EntryTimestamp = [System.DateTimeOffset]::new(2026, 1, 1, 0, 0, 0, [System.TimeSpan]::Zero)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Writes $Paths (relative to $root) to $Destination with forward-slash entry
# names, sorted order and normalised timestamps. Returns the files it wrote.
function Write-Zip {
    param(
        [Parameter(Mandatory)] [string]   $Destination,
        [Parameter(Mandatory)] [string[]] $Paths
    )

    $files = Get-ChildItem -Path ($Paths | ForEach-Object { Join-Path $root $_ }) -Recurse -File |
        Sort-Object FullName

    Remove-Item $Destination -Force -ErrorAction SilentlyContinue
    $stream = [System.IO.File]::Open($Destination, [System.IO.FileMode]::CreateNew)
    try {
        $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($file in $files) {
                $name = $file.FullName.Substring($root.Length + 1).Replace('\', '/')
                $entry = $archive.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
                $entry.LastWriteTime = $EntryTimestamp
                $entryStream = $entry.Open()
                try {
                    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
                    $entryStream.Write($bytes, 0, $bytes.Length)
                } finally {
                    $entryStream.Dispose()
                }
            }
        } finally {
            $archive.Dispose()
        }
    } finally {
        $stream.Dispose()
    }

    return $files
}

function Show-Contents {
    param([Parameter(Mandatory)] [string] $Path)

    $check = [System.IO.Compression.ZipFile]::OpenRead($Path)
    try {
        Write-Host "`n$(Split-Path $Path -Leaf) - $($check.Entries.Count) files:"
        $check.Entries | ForEach-Object { '{0,8}  {1}' -f $_.Length, $_.FullName }
    } finally {
        $check.Dispose()
    }
}

$version = (Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json).version
Write-Host "SoloSend $version"

# Optional syntax check; skipped when node is absent.
if (Get-Command node -ErrorAction SilentlyContinue) {
    foreach ($js in 'background.js', 'dialog/dialog.js') {
        & node --check (Join-Path $root $js)
        if ($LASTEXITCODE -ne 0) { throw "Syntax error in $js" }
    }
    Write-Host 'Syntax check passed.'
} else {
    Write-Host 'node not found - skipping the optional syntax check.'
}

New-Item -ItemType Directory -Force $dist | Out-Null

$xpi = Join-Path $dist "solosend-$version.xpi"
$shippedFiles = Write-Zip -Destination $xpi -Paths $Shipped
Show-Contents -Path $xpi

# Runtime-independent: lets a reviewer confirm the submitted .xpi and the source
# archive hold identical files, whatever built them.
Write-Host "`nSHA-256 of each shipped file:"
foreach ($file in $shippedFiles) {
    '{0}  {1}' -f (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLower(),
                  $file.FullName.Substring($root.Length + 1).Replace('\', '/')
}

$outputs = @($xpi)
if ($Source) {
    $srcZip = Join-Path $dist "solosend-$version-source.zip"
    Write-Zip -Destination $srcZip -Paths ($Shipped + $SourceOnly) | Out-Null
    Show-Contents -Path $srcZip
    $outputs += $srcZip
}

Write-Host "`nSHA-256 of each package:"
foreach ($out in $outputs) {
    '{0}  {1}' -f (Get-FileHash $out -Algorithm SHA256).Hash.ToLower(), (Split-Path $out -Leaf)
}

Write-Host ''
$outputs | ForEach-Object { $_ }
