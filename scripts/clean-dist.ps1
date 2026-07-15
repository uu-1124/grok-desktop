$ErrorActionPreference = "Stop"

$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$distCandidate = Join-Path $workspaceRoot "dist"

if (-not (Test-Path -LiteralPath $distCandidate)) {
  exit 0
}

$distItem = Get-Item -LiteralPath $distCandidate
if ($distItem.LinkType) {
  throw "Refusing to clean linked dist path: $($distItem.FullName)"
}

$distPath = (Resolve-Path -LiteralPath $distCandidate).Path
$expectedPath = [System.IO.Path]::Combine($workspaceRoot, "dist")
if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals($distPath, $expectedPath)) {
  throw "Refusing to clean unexpected path: $distPath"
}

Remove-Item -LiteralPath $distPath -Recurse -Force
