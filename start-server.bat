@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title СВОЯ ИГРА — запуск сервера

echo.
echo  ╔════════════════════════════════════════════════════╗
echo  ║                  СВОЯ ИГРА                        ║
echo  ║                  ЯЧЕЙКА 9.11                      ║
echo  ╚════════════════════════════════════════════════════╝
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [ОШИБКА] Node.js не найден.
  echo  Установите Node.js 18+ с https://nodejs.org и запустите файл снова.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo  [ОШИБКА] npm не найден. Переустановите Node.js с npm.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\express\package.json" (
  echo  Зависимости не найдены. Выполняем npm install...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  [ОШИБКА] Не удалось установить зависимости.
    pause
    exit /b 1
  )
)

if defined HOST_PASSWORD (
  echo  Пароль /host и /editor: задан через HOST_PASSWORD
) else (
  echo  Пароль /host и /editor по умолчанию: svoya
)
echo  Адрес для телефонов будет показан ниже и в лобби /screen.
echo.
echo  Не закрывайте это окно, пока идёт игра.
echo.

if /I not "%~1"=="--no-browser" (
  start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:3000/host'; Start-Process 'http://localhost:3000/screen'"
)

call npm start

echo.
echo  Сервер остановлен.
pause
endlocal
