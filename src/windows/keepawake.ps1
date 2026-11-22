$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class QuestAwake
{
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint flags);

    public static uint On() { return SetThreadExecutionState(0x80000000u | 0x00000001u | 0x00000002u); }
}
'@

# Держим систему и дисплей активными, пока сессия не остановится вместе с процессом.
while ($true) {
  [void][QuestAwake]::On()
  Start-Sleep -Seconds 45
}
