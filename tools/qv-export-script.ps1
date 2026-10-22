<#
.SYNOPSIS
  Выгружает скрипт загрузки из документа QlikView (.qvw) в файл .qvs
  для последующего анализа: qlik-analyzer analyze --script <file.qvs>

.DESCRIPTION
  QlikView Server 12 не отдаёт содержимое приложения через QIX Engine API
  (в отличие от Qlik Sense), а формат .qvw — проприетарный бинарный контейнер.
  Поэтому скрипт выгружается через COM-автоматизацию QlikView Desktop.

  Скрипт пробует несколько известных способов получить текст скрипта и
  использует первый сработавший. Если ни один не подошёл — выводит понятную
  инструкцию по ручному экспорту (File → Export → Script).

  ТРЕБОВАНИЯ: Windows, установленный QlikView Desktop с лицензией на запуск
  автоматизации, доступ к папке с документами (локальной или сетевой).

  ВАЖНО: код написан по открытым источникам и НЕ проверялся на вашем стенде.
  Прогоните на копии документа и сверьте результат с оригиналом.

.PARAMETER Path
  Путь к документу .qvw (локальный или UNC, например \\server\folder\app.qvw).

.PARAMETER OutFile
  Куда сохранить скрипт. По умолчанию — <имя .qvw>.qvs рядом с исходником.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\qv-export-script.ps1 -Path "\\qv01\Apps\Sales.qvw"
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Path,

  [string]$OutFile
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) {
  Write-Error "Документ не найден: $Path"
  exit 1
}

if (-not $OutFile) {
  $base = [System.IO.Path]::GetFileNameWithoutExtension($Path)
  $dir = [System.IO.Path]::GetDirectoryName($Path)
  $OutFile = Join-Path $dir "$base.qvs"
}

Write-Host "Открываю документ: $Path"

$app = $null
$doc = $null
try {
  $app = New-Object -ComObject QlikView.Application
  $app.Visible = $false
  $doc = $app.Open($Path)
  Write-Host "Документ открыт: $($doc.GetName())"
}
catch {
  Write-Warning "Не удалось открыть документ через COM: $($_.Exception.Message)"
  Write-Warning "Возможные причины: не установлен QlikView Desktop, нет лицензии на автоматизацию, нет прав на файл."
}

$script = $null
if ($doc) {
  # Пробуем известные способы получить текст скрипта.
  $attempts = @(
    { $doc.GetScript() },
    { $doc.Script },
    { $doc.ExportScript() }
  )
  foreach ($attempt in $attempts) {
    try {
      $candidate = & $attempt
      if ($candidate -and ($candidate -is [string]) -and $candidate.Trim().Length -gt 0) {
        $script = $candidate
        break
      }
    }
    catch {
      # метод недоступен в этой версии — пробуем следующий
    }
  }
}

if ($script) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($OutFile, $script, $enc)
  Write-Host "Скрипт сохранён: $OutFile ($($script.Length) символов)"
  Write-Host "Теперь проанализируйте его: qlik-analyzer analyze --script `"$OutFile`""
}
else {
  Write-Warning "Через COM получить текст скрипта не удалось (метод зависит от версии QlikView)."
  Write-Host ""
  Write-Host "Ручной экспорт (надёжный путь):"
  Write-Host "  1. Откройте документ в QlikView Desktop: $Path"
  Write-Host "  2. Перейдите в редактор скрипта (Edit Script / Ctrl+E)."
  Write-Host "  3. File -> Export -> Script... и сохраните как .qvs"
  Write-Host "  4. Запустите: qlik-analyzer analyze --script `"<сохранённый файл>.qvs`""
  Write-Host ""
  Write-Host "Проверка целостности выгруженного скрипта: node bin/analyze.js analyze --script <file>"
  exit 2
}

finally {
  if ($doc) { try { $doc.Close() } catch {} }
  if ($app) { try { $app.Quit() } catch {} }
}
