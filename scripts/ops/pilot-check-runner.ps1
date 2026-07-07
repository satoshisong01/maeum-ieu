# 마음이음 파일럿 일일 점검 러너 — Windows 작업 스케줄러가 매일 실행.
#   pilot-daily-check.ts를 돌려 로그(.pilot-logs/)에 남기고,
#   문제(exit 1=미발송 응급 / 2=스크립트 실패) 시에만 팝업을 띄운다. 정상(0)이면 조용히 종료.
$ErrorActionPreference = "Continue"
$proj = "C:\Users\jungm\Desktop\projects\maeum-ieu"
$logDir = Join-Path $proj ".pilot-logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$log = Join-Path $logDir "check_$stamp.log"

Set-Location $proj
cmd /c "npx tsx scripts\pilot-daily-check.ts >> `"$log`" 2>&1"
$code = $LASTEXITCODE
Add-Content -Path $log -Value "`r`n[exit=$code]"

# 30일 지난 로그 정리(용량·PII 관리)
Get-ChildItem $logDir -Filter "check_*.log" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item -Force -ErrorAction SilentlyContinue

if ($code -ne 0) {
  Add-Type -AssemblyName System.Windows.Forms
  if ($code -eq 1) {
    $msg = "[긴급] 마음이음 점검: 발송 안 된 위급 알림이 발견됐습니다!`n`nFCM/알림 채널을 즉시 점검하세요.`n로그: $log"
  } else {
    $msg = "[주의] 마음이음 점검 스크립트가 실행에 실패했습니다 (code $code).`n`nDB 연결·환경을 확인하세요.`n로그: $log"
  }
  [System.Windows.Forms.MessageBox]::Show($msg, "마음이음 파일럿 점검", 0, 48) | Out-Null
}
exit $code
