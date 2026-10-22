# Собранные версии qlik-analyzer

Здесь хранятся **все** сборки десктоп-приложения. Ничего не удаляется — каждая новая
версия добавляется рядом с предыдущими. Полное описание изменений — в `CHANGELOG.md`
в корне проекта, исходники каждой версии — в git по тегу `v<версия>`.

| Файл | Платформа | Архитектура | Размер | Версия |
|---|---|---|---|---|
| `Qlik Analyzer-0.1.6-x64.exe` | Windows | x64 (NSIS-инсталлятор) | 107 МБ | 0.1.6 |
| `Qlik Analyzer-0.1.6-arm64.dmg` | macOS | Apple Silicon (установщик) | 115 МБ | 0.1.6 |
| `Qlik Analyzer-0.1.6-arm64-mac.zip` | macOS | Apple Silicon (архив) | 115 МБ | 0.1.6 |
| `Qlik Analyzer-0.1.5-x64.exe` | Windows | x64 (NSIS-инсталлятор) | 107 МБ | 0.1.5 |
| `Qlik Analyzer-0.1.5-arm64.dmg` | macOS | Apple Silicon (установщик) | 115 МБ | 0.1.5 |

Служебные каталоги: `win-unpacked/` (распакованная Windows-версия), `mac/` (Intel x64),
`mac-arm64/` (Apple Silicon) — пересобираются при каждой сборке.

## Пересборка конкретной версии

```bash
cd qlik-analyzer
git checkout v0.1.5
cd desktop && npm ci && npm run build
npx electron-builder --win --x64 --config.win.target=nsis
npx electron-builder --mac dmg
```

## Установка на Windows

`Qlik Analyzer-0.1.5-x64.exe` — установщик NSIS: спросит папку, создаст ярлык на рабочем столе.
Приложение пока не подписано — SmartScreen предупредит, нужно «Подробнее» → «Выполнить в любом случае».
