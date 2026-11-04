# DESKDATA: homologacao de instalador assinado (Windows PowerShell 5.1+).
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Test-Path 'package-lock.json')) {
    throw 'package-lock.json ausente. Execute npm install uma vez e revise o lockfile antes de distribuir.'
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Falha: $Command $($Arguments -join ' ')" }
}

Invoke-Checked 'npm' @('ci')
Invoke-Checked 'npm' @('test')
Invoke-Checked 'npm' @('run', 'dist:win')

$installers = @(Get-ChildItem -Path 'release' -File -Filter '*.exe' -ErrorAction Stop)
if ($installers.Count -eq 0) { throw 'Nenhum instalador .exe produzido.' }
foreach ($installer in $installers) {
    $signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
    if ($signature.Status -ne 'Valid') {
        throw "Assinatura Authenticode não validada: $($installer.Name) ($($signature.Status)). Não distribuir."
    }
    $hash = Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256
    Write-Host "Assinado: $($installer.FullName)" -ForegroundColor Green
    Write-Host "SHA-256 : $($hash.Hash)"
}
