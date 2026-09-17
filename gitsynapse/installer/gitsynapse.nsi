;
; GitSynapse — Windows installer (NSIS 3 / Modern UI 2)
;
; Built natively with makensis on any platform: no Wine, no Windows SDK, no
; emulation layer in the build path. electron-builder produces the unpacked app
; directory (release/win-unpacked), scripts/brand-exe.cjs applies the icon and
; version metadata, and this script wraps it into GitSynapse-setup.exe.
;
; Compile:
;   makensis -DAPP_DIR=<dir> -DOUT_FILE=<exe> -DAPP_VERSION=<x.y.z> installer/gitsynapse.nsi
;
; Design decisions worth stating:
;   * Per-user by default ($LOCALAPPDATA\Programs\GitSynapse) so installation needs
;     no administrator rights. `RequestExecutionLevel highest` silently stays
;     unelevated for standard accounts and elevates only when the account can,
;     which also lets an administrator choose a machine-wide directory.
;   * The uninstaller relaunches itself from %TEMP%. A running executable cannot
;     delete itself, and leaving this file behind in the install directory is
;     the single most common NSIS wart.
;   * User data (settings, API key, chat history) lives in %APPDATA%\GitSynapse and
;     is only removed when the user explicitly asks for it.
;

Unicode true

!ifndef APP_DIR
  !error "APP_DIR is required (the win-unpacked directory)"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "release\GitSynapse-setup.exe"
!endif
!ifndef APP_VERSION
  !define APP_VERSION "0.1.0"
!endif
!ifndef ICON_FILE
  !define ICON_FILE "assets\icon.ico"
!endif

!define APP_NAME "GitSynapse"
!define APP_EXE "GitSynapse.exe"
!define APP_PUBLISHER "GitSynapse"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\GitSynapse"
!define UNINSTALLER "$INSTDIR\Uninstall GitSynapse.exe"
!define DATA_DIR "$APPDATA\GitSynapse"

Name "${APP_NAME}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_NAME}" "InstallDir"
RequestExecutionLevel highest
SetCompressor /SOLID lzma

; Show what is happening: this is a tool for people who want to see the detail.
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName"     "${APP_NAME}"
VIAddVersionKey /LANG=1033 "FileDescription" "${APP_NAME} Setup"
VIAddVersionKey /LANG=1033 "FileVersion"     "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion"  "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "CompanyName"     "${APP_PUBLISHER}"
VIAddVersionKey /LANG=1033 "LegalCopyright"  "Copyright (c) ${APP_PUBLISHER}"

; ---------------------------------------------------------------------------
; Modern UI
; ---------------------------------------------------------------------------

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define MUI_ICON   "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "${APP_NAME} ${APP_VERSION}"
!define MUI_WELCOMEPAGE_TEXT "This will install ${APP_NAME} on your computer.$\r$\n$\r$\n${APP_NAME} is a graphical front end for the Git already installed on this machine. It does not replace or modify your Git installation, and it never changes a repository without showing you the exact command first.$\r$\n$\r$\nGit must already be installed and available on your PATH."
!define MUI_DIRECTORYPAGE_TEXT_TOP "Setup will install ${APP_NAME} into the folder below. Installing for the current user only requires no administrator rights.$\r$\n$\r$\nKeep this folder on a local disk. Installing into a network location is not supported."
!define MUI_FINISHPAGE_TITLE "${APP_NAME} is installed"
!define MUI_FINISHPAGE_TEXT "${APP_NAME} will use the Git already on your PATH. If Git is not installed yet, install it from git-scm.com and then start ${APP_NAME} again.$\r$\n$\r$\nTo use the AI copilot, open Settings in the app and paste your Mesh API key."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Start ${APP_NAME} now"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ---------------------------------------------------------------------------
; Install
; ---------------------------------------------------------------------------

Section "GitSynapse" SecMain
  SectionIn RO

  ; Refuse to install into a drive root, which would make the uninstaller's
  ; recursive delete catastrophic.
  ${GetRoot} "$INSTDIR" $R0
  ${If} "$INSTDIR" == "$R0"
    MessageBox MB_ICONSTOP|MB_OK "Please choose a folder for ${APP_NAME} rather than a drive root."
    Abort
  ${EndIf}

  SetOutPath "$INSTDIR"
  SetOverwrite on

  DetailPrint "Copying application files..."
  File /r "${APP_DIR}\*.*"

  DetailPrint "Writing the uninstaller..."
  WriteUninstaller "${UNINSTALLER}"

  ; --- Registry: remember where we went, and register with Add/Remove Programs.
  WriteRegStr HKCU "Software\${APP_NAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\${APP_NAME}" "Version" "${APP_VERSION}"

  WriteRegStr   HKCU "${UNINSTALL_KEY}" "DisplayName"     "${APP_NAME}"
  WriteRegStr   HKCU "${UNINSTALL_KEY}" "DisplayVersion"  "${APP_VERSION}"
  WriteRegStr   HKCU "${UNINSTALL_KEY}" "Publisher"       "${APP_PUBLISHER}"
  WriteRegStr   HKCU "${UNINSTALL_KEY}" "DisplayIcon"     "$INSTDIR\${APP_EXE},0"
  WriteRegStr   HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKCU "${UNINSTALL_KEY}" "UninstallString" '"${UNINSTALLER}"'
  WriteRegStr   HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"${UNINSTALLER}" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1

  ; Reported size in Add/Remove Programs, in KB.
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" "$0"

  ; --- Shortcuts
  DetailPrint "Creating shortcuts..."
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "${UNINSTALLER}"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
SectionEnd

; ---------------------------------------------------------------------------
; Uninstall
; ---------------------------------------------------------------------------

; A running process cannot delete its own executable, and the uninstaller always
; lives inside $INSTDIR. So the first pass copies itself to %TEMP% and restarts
; from there; the copy does the deleting and then removes itself.
;
; The two passes are distinguished by comparing $EXEPATH with the temp path,
; rather than by parsing a command-line flag. That is self-describing: there is
; no argument to forget to parse, and no way for the two states to disagree.
Var /GLOBAL IsTempCopy

Function un.onInit
  StrCpy $IsTempCopy "0"

  ${If} $EXEPATH == "$TEMP\GitSynapseUninstall.exe"
    ; Second pass: already running from %TEMP%, so $INSTDIR is free to delete.
    StrCpy $IsTempCopy "1"
    Return
  ${EndIf}

  ; First pass: relocate and hand over.
  CopyFiles /SILENT "$EXEPATH" "$TEMP\GitSynapseUninstall.exe"
  ${If} ${FileExists} "$TEMP\GitSynapseUninstall.exe"
    Exec '"$TEMP\GitSynapseUninstall.exe"'
    Quit
  ${EndIf}

  ; If the copy failed (locked temp, no permissions) continue in place: the
  ; directory removal below tolerates a locked uninstaller and leaves it behind.
FunctionEnd

Section "Uninstall"
  ; Guard: never recurse blindly from an empty or root path.
  StrCmp "$INSTDIR" "" abortPath
  ${GetRoot} "$INSTDIR" $R0
  StrCmp "$INSTDIR" "$R0" abortPath

  DetailPrint "Closing ${APP_NAME} if it is running..."
  ExecWait '"$SYSDIR\taskkill.exe" /IM "${APP_EXE}" /F' $1

  DetailPrint "Removing shortcuts..."
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"

  DetailPrint "Removing registry entries..."
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\${APP_NAME}"

  ; Settings, the encrypted API key and chat history live outside the install
  ; directory. Ask before touching them, and default to keeping them.
  IfSilent keepData
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "Also delete your ${APP_NAME} settings, saved API key and chat history?$\r$\n$\r$\nThey are stored in:$\r$\n${DATA_DIR}$\r$\n$\r$\nChoose No to keep them, for example if you plan to reinstall." \
    IDYES deleteData IDNO keepData

  deleteData:
    DetailPrint "Removing user data..."
    RMDir /r "${DATA_DIR}"

  keepData:

  DetailPrint "Removing application files..."
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.txt"
  Delete "$INSTDIR\*.html"
  Delete "$INSTDIR\${APP_EXE}"
  RMDir "$INSTDIR"

  ; A leftover directory means the app was still running and the exe is locked.
  IfFileExists "$INSTDIR\*.*" 0 clean
    DetailPrint "Some files are still in use. They will be removed after a restart."
    SetRebootFlag true
  clean:

  ; Remove the temporary copy of the uninstaller, now that it has done its work.
  ${If} $IsTempCopy == "1"
    Delete /REBOOTOK "$TEMP\GitSynapseUninstall.exe"
  ${EndIf}

  Goto finished

  abortPath:
    MessageBox MB_ICONSTOP|MB_OK "The installation path looks unsafe, so nothing was removed:$\r$\n$INSTDIR"

  finished:
SectionEnd
