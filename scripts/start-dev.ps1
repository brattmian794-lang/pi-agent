# Windows PowerShell 5.1 / PowerShell 7；由公共 Bun 启动器提供中文提示。
$ErrorActionPreference = 'Stop'
$bun = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue
if (-not $bun) {
    [Console]::Error.WriteLine('Bun not found. Install Bun from https://bun.sh and reopen the terminal. See docs/development.md.')
    exit 127
}
try {
    & $bun.Source (Join-Path $PSScriptRoot 'start-dev.ts') @args
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
