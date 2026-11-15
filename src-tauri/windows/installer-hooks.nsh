; Hooks for the NSIS installer (the setup .exe), wired up in tauri.conf.json: bundle.windows.nsis.installerHooks.
;
; Up to v0.5.x the app was called "Rclone GUI". The NSIS installer keys an install on the product name (its
; folder, its uninstall entry, its shortcuts), so without this hook Arcus would install next to Rclone GUI
; rather than replace it. Before installing, run the old version's own uninstaller silently. That keeps the
; user's data: up to v0.9.1 settings, rclone binaries, job history and logs lived under the bundle identifier
; (com.rclonegui.desktop), which did not change (Arcus moves them to its own folders when it starts, paths.rs),
; and the uninstaller only deletes them when its "Delete the application data" box is ticked, which a silent run
; never shows. No /UPDATE flag: with it the uninstaller
; would leave the old shortcuts and uninstall entry behind.
;
; The MSI keeps upgrading in place instead, through the pinned bundle.windows.wix.upgradeCode.

!define ARCUS_OLD_PRODUCTNAME "Rclone GUI"

!macro ArcusRemoveOldInstall ROOT
  Push $R8
  Push $R9
  ReadRegStr $R8 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\${ARCUS_OLD_PRODUCTNAME}" "UninstallString"
  ; The unquoted install folder, as Tauri's own installer reads it when it replaces an older version.
  ReadRegStr $R9 ${ROOT} "${MANUKEY}\${ARCUS_OLD_PRODUCTNAME}" ""
  ${If} $R8 != ""
  ${AndIf} $R9 != ""
  ${AndIf} ${FileExists} "$R9\uninstall.exe"
    DetailPrint "Removing ${ARCUS_OLD_PRODUCTNAME}, this app's name before v0.6; your data is kept."
    ; _?= runs the uninstaller in place, so ExecWait really waits for it to finish.
    ExecWait '"$R9\uninstall.exe" /S _?=$R9'
    ; Run in place, the uninstaller cannot remove itself or its folder.
    Delete "$R9\uninstall.exe"
    RMDir "$R9"
  ${EndIf}
  Pop $R9
  Pop $R8
!macroend

; Tauri's "Delete the application data" box removes the folders named after the identifier. Since v0.9.2 the data
; is in %APPDATA%\Arcus and the logs in %LOCALAPPDATA%\Arcus\logs (paths.rs), so those go too. Not on an update.
; %LOCALAPPDATA%\Arcus itself is the default install folder; it goes when it is empty.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RmDir /r "$APPDATA\Arcus"
    RmDir /r "$LOCALAPPDATA\Arcus\logs"
    RmDir "$LOCALAPPDATA\Arcus"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro ArcusRemoveOldInstall HKCU
  !insertmacro ArcusRemoveOldInstall HKLM
!macroend
