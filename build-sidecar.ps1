$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgeScript = Join-Path $projectRoot "src-tauri\python\live_bridge.py"
$binaryDirectory = Join-Path $projectRoot "src-tauri\binaries"
$workDirectory = Join-Path $projectRoot "src-tauri\.pyinstaller"

New-Item -ItemType Directory -Force -Path $binaryDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $workDirectory | Out-Null

python -m PyInstaller `
  --noconfirm `
  --clean `
  --onefile `
  --name voxa-live-bridge `
  --distpath $binaryDirectory `
  --workpath (Join-Path $workDirectory "work") `
  --specpath $workDirectory `
  $bridgeScript

if ($LASTEXITCODE -ne 0) {
  throw "Could not build the Voxa transcription sidecar."
}

Write-Host "Sidecar ready: $binaryDirectory\voxa-live-bridge.exe"
