; Extra steps for the Windows installer (electron-builder's NSIS script includes this file).
;
; electron-builder keeps a full copy of the installer under %LOCALAPPDATA%\<name>-updater for
; its updater to reuse, and its uninstaller never removes it. This app has no updater, so the
; copy is only wasted disk space: remove it at the end of the install, and again on uninstall
; in case an older installer left one behind.

!macro removeInstallerCopy
  !ifdef APP_INSTALLER_STORE_FILE
    Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
    ${StdUtils.GetParentPath} $R9 "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
    RMDir "$R9"
  !endif
!macroend

; The same program started with --gallery is Photobook Gallery: it gets its own Start-menu and
; desktop shortcuts, with the app's icon (index 0). Each carries the gallery's AppUserModelID
; (GALLERY_APP_ID in electron/config.ts), the one the gallery's window sets, so Windows keeps
; the two programs apart on the taskbar. WinShell is the plugin electron-builder's own shortcuts
; use. electron-builder creates the editor's shortcuts the same way, under the same shell context
; (per user here), so $SMPROGRAMS and $DESKTOP are the ones the editor's shortcuts are in.
;
; Installing always (re)creates them, so an update from a version without the gallery adds them;
; the desktop one is left out when the installer is run with --no-desktop-shortcut, as the
; editor's is. Uninstalling removes both and nothing else: neither program's data is deleted, as
; with deleteAppDataOnUninstall: false. An update runs the old uninstaller with --keep-shortcuts
; first; then they are kept, as the editor's are, so a gallery pinned to the taskbar stays pinned.
; (isNoDesktopShortcut and isKeepShortcuts are electron-builder's tests of those flags.)

!macro addGalleryShortcuts
  CreateShortCut "$SMPROGRAMS\Photobook Gallery.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--gallery" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "Look through a folder of photos and star the best ones"
  ClearErrors
  WinShell::SetLnkAUMI "$SMPROGRAMS\Photobook Gallery.lnk" "app.photobookstudio.gallery"
  ${ifNot} ${isNoDesktopShortcut}
    CreateShortCut "$DESKTOP\Photobook Gallery.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--gallery" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "Look through a folder of photos and star the best ones"
    ClearErrors
    WinShell::SetLnkAUMI "$DESKTOP\Photobook Gallery.lnk" "app.photobookstudio.gallery"
  ${endIf}
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro removeGalleryShortcuts
  ${ifNot} ${isKeepShortcuts}
    WinShell::UninstAppUserModelId "app.photobookstudio.gallery"
    WinShell::UninstShortcut "$SMPROGRAMS\Photobook Gallery.lnk"
    Delete "$SMPROGRAMS\Photobook Gallery.lnk"
    WinShell::UninstShortcut "$DESKTOP\Photobook Gallery.lnk"
    Delete "$DESKTOP\Photobook Gallery.lnk"
  ${endIf}
!macroend

!macro customInstall
  !insertmacro removeInstallerCopy
  !insertmacro addGalleryShortcuts
!macroend

!macro customUnInstall
  !insertmacro removeInstallerCopy
  !insertmacro removeGalleryShortcuts
!macroend
