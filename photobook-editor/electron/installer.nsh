; Photobook Editor's one extra step for the Windows installer (electron-builder's NSIS script includes this file).
;
; electron-builder keeps a full copy of the installer under %LOCALAPPDATA%\<name>-updater for
; its updater to reuse, and its uninstaller never removes it. This app has no updater, so the
; copy is only wasted disk space: remove it at the end of the install, and again on uninstall
; in case an older installer left one behind. Nothing else: no shortcuts beyond electron-builder's
; own, no other program's taskbar identity, and no user data is touched.

!macro removeInstallerCopy
  !ifdef APP_INSTALLER_STORE_FILE
    Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
    ${StdUtils.GetParentPath} $R9 "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
    RMDir "$R9"
  !endif
!macroend

!macro customInstall
  !insertmacro removeInstallerCopy
!macroend

!macro customUnInstall
  !insertmacro removeInstallerCopy
!macroend
