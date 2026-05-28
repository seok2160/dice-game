@echo off
title Dice Board Game Server
cd /d "%~dp0"
echo.
echo  ===================================
echo   Dice Board Game Server
echo  ===================================
echo.
echo  서버를 시작합니다. 잠시 기다리세요...
echo  공개 URL은 아래 "공개 :" 줄을 확인하세요.
echo  이 창을 닫으면 서버가 종료됩니다.
echo.
start /b cmd /c "timeout /t 3 /nobreak > nul && start http://localhost:8080"
npm run dev
pause
