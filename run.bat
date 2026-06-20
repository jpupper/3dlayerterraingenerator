@echo off
title 3D Layer Terrain Generator
cd /d "%~dp0"

echo [1/3] Matando servidor previo en puerto 4938...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :4938') do (
    if not "%%a"=="" (
        taskkill /F /PID %%a >nul 2>&1
    )
)
timeout /t 1 /nobreak >nul

echo [2/3] Iniciando servidor...
start "" /B node server/index.js

timeout /t 2 /nobreak >nul

echo [3/3] Abriendo navegador...
start "" http://localhost:4938

echo.
echo  3D Layer Terrain Generator corriendo en http://localhost:4938
echo  Cerrar esta ventana NO detiene el servidor.
echo  Para detenerlo, use: taskkill /F /IM node.exe
echo.
