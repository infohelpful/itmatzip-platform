import { DESKTOP_ICONS, EFFECTS, START_FOLDERS } from "./catalog.js";
import { embedSetupFile, toBase64Bytes } from "./embed.js";
import texts from "./vendor-text.js";

const EMPTY_START_TILES = `<LayoutModificationTemplate Version='1' xmlns='http://schemas.microsoft.com/Start/2014/LayoutModification'>
  <LayoutOptions StartTileGroupCellWidth='6' />
  <DefaultLayoutOverride>
    <StartLayoutCollection>
      <StartLayout GroupCellWidth='6' xmlns='http://schemas.microsoft.com/Start/2014/FullDefaultLayout' />
    </StartLayoutCollection>
  </DefaultLayoutOverride>
</LayoutModificationTemplate>`;

const EMPTY_TASKBAR = `<LayoutModificationTemplate xmlns="http://schemas.microsoft.com/Start/2014/LayoutModification" xmlns:defaultlayout="http://schemas.microsoft.com/Start/2014/FullDefaultLayout" xmlns:start="http://schemas.microsoft.com/Start/2014/StartLayout" xmlns:taskbar="http://schemas.microsoft.com/Start/2014/TaskbarLayout" Version="1">
  <CustomTaskbarLayoutCollection PinListPlacement="Replace">
    <defaultlayout:TaskbarLayout>
      <taskbar:TaskbarPinList>
        <taskbar:DesktopApp DesktopApplicationLinkPath="#leaveempty" />
      </taskbar:TaskbarPinList>
    </defaultlayout:TaskbarLayout>
  </CustomTaskbarLayoutCollection>
</LayoutModificationTemplate>`;

function regAdd(path, name, type, value) {
  return `reg.exe add "${path}" /v ${name} /t ${type} /d ${value} /f`;
}

function stickyFlags(config) {
  let result = 0x00000002 | 0x00000008;
  if (config.stickyKeys === "disable") return result;
  if (config.stickyHotKey) result |= 0x00000004;
  if (config.stickyHotKeySound) result |= 0x00000010;
  if (config.stickyIndicator) result |= 0x00000020;
  if (config.stickyAudible) result |= 0x00000040;
  if (config.stickyTriState) result |= 0x00000080;
  if (config.stickyTwoKeysOff) result |= 0x00000100;
  return result;
}

function lockIndicators(config) {
  let value = 0;
  if (config.capsInitial === "on") value |= 1;
  if (config.numInitial === "on") value |= 2;
  if (config.scrollInitial === "on") value |= 4;
  return value;
}

function scancodeMapBase64(config) {
  const maps = [];
  if (config.capsBehavior === "ignore") maps.push([0, 0, 0x3a, 0]);
  if (config.numBehavior === "ignore") maps.push([0, 0, 0x45, 0]);
  if (config.scrollBehavior === "ignore") maps.push([0, 0, 0x46, 0]);
  if (!maps.length) return "";
  const count = maps.length + 1;
  const bytes = new Uint8Array(12 + maps.length * 4 + 4);
  bytes[8] = count & 0xff;
  bytes[9] = (count >> 8) & 0xff;
  bytes[10] = (count >> 16) & 0xff;
  bytes[11] = (count >> 24) & 0xff;
  let offset = 12;
  for (const row of maps) {
    bytes.set(row, offset);
    offset += 4;
  }
  return toBase64Bytes(bytes);
}

function effectPairs(config) {
  if (config.effectsMode === "appearance") return EFFECTS.map((item) => [item.id, true]);
  if (config.effectsMode === "performance") return EFFECTS.map((item) => [item.id, false]);
  if (config.effectsMode === "custom") return EFFECTS.map((item) => [item.id, !!config.effects?.[item.id]]);
  return [];
}

function visualFxSetting(config) {
  if (config.effectsMode === "appearance") return 1;
  if (config.effectsMode === "performance") return 2;
  if (config.effectsMode === "custom") return 3;
  return 0;
}

function taskbarXml(config) {
  if (config.taskbarIcons === "none") return EMPTY_TASKBAR;
  if (config.taskbarIcons === "xml" && config.taskbarIconsXml.trim()) return config.taskbarIconsXml.trim();
  return "";
}

function startTilesXml(config) {
  if (config.startTiles === "none") return EMPTY_START_TILES;
  if (config.startTiles === "xml" && config.startTilesXml.trim()) return config.startTilesXml.trim();
  return "";
}

export function defaultHiveCommands(config, extraAdds = []) {
  const before = [];
  const hive = "HKU\\DefaultUser";
  const load = `reg.exe load ${hive} C:\\Users\\Default\\NTUSER.DAT`;
  const unload = `reg.exe unload ${hive}`;
  const add = [];
  const adv = `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced`;
  if (config.showExtensions) add.push(regAdd(adv, "HideFileExt", "REG_DWORD", 0));
  if (config.hideFiles === "showall") {
    add.push(regAdd(adv, "Hidden", "REG_DWORD", 1));
    add.push(regAdd(adv, "ShowSuperHidden", "REG_DWORD", 1));
  } else if (config.hideFiles === "protected") {
    add.push(regAdd(adv, "Hidden", "REG_DWORD", 1));
  }
  if (config.launchToThisPC) add.push(regAdd(adv, "LaunchTo", "REG_DWORD", 1));
  if (config.hideTaskView) add.push(regAdd(adv, "ShowTaskViewButton", "REG_DWORD", 0));
  if (config.disableWidgets) add.push(regAdd(adv, "TaskbarDa", "REG_DWORD", 0));
  if (config.leftTaskbar) add.push(regAdd(adv, "TaskbarAl", "REG_DWORD", 0));
  if (config.hideInfoTip) add.push(regAdd(adv, "ShowInfoTip", "REG_DWORD", 0));
  const searchMap = { hide: 0, icon: 1, box: 2, label: 3 };
  if (config.taskbarSearch && config.taskbarSearch !== "box") {
    add.push(regAdd(`${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Search`, "SearchboxTaskbarMode", "REG_DWORD", searchMap[config.taskbarSearch] ?? 2));
  }
  if (config.showEndTask) {
    add.push(`reg.exe add "${adv}\\TaskbarDeveloperSettings" /v TaskbarEndTask /t REG_DWORD /d 1 /f`);
  }
  if (config.disableBing) {
    add.push(`reg.exe add "${hive}\\Software\\Policies\\Microsoft\\Windows\\Explorer" /v DisableSearchBoxSuggestions /t REG_DWORD /d 1 /f`);
  }
  if (config.classicContextMenu) {
    add.push(`reg.exe add "${hive}\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32" /ve /f`);
  }
  if (config.colorMode === "custom") {
    const theme = `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize`;
    add.push(regAdd(theme, "AppsUseLightTheme", "REG_DWORD", config.themeApps === "light" ? 1 : 0));
    add.push(regAdd(theme, "SystemUsesLightTheme", "REG_DWORD", config.themeSystem === "light" ? 1 : 0));
    add.push(regAdd(`${hive}\\Software\\Microsoft\\Windows\\DWM`, "ColorPrevalence", "REG_DWORD", config.accentOnBorders ? 1 : 0));
  }
  if (config.stickyKeys === "disable" || config.stickyKeys === "custom") {
    add.push(`reg.exe add "${hive}\\Control Panel\\Accessibility\\StickyKeys" /v Flags /t REG_SZ /d ${stickyFlags(config)} /f`);
  }
  if (config.lockKeys) {
    add.push(`reg.exe add "${hive}\\Control Panel\\Keyboard" /v InitialKeyboardIndicators /t REG_SZ /d ${lockIndicators(config)} /f`);
  }
  if (config.disablePointerPrecision) {
    add.push(`reg.exe add "${hive}\\Control Panel\\Mouse" /v MouseSpeed /t REG_SZ /d 0 /f`);
    add.push(`reg.exe add "${hive}\\Control Panel\\Mouse" /v MouseThreshold1 /t REG_SZ /d 0 /f`);
    add.push(`reg.exe add "${hive}\\Control Panel\\Mouse" /v MouseThreshold2 /t REG_SZ /d 0 /f`);
  }
  if (config.turnOffSounds) {
    add.push(`reg.exe add "${hive}\\AppEvents\\Schemes" /ve /t REG_SZ /d ".None" /f`);
  }
  if (config.disableSmartScreen) {
    add.push(`reg.exe add "${hive}\\Software\\Microsoft\\Edge\\SmartScreenEnabled" /ve /t REG_DWORD /d 0 /f`);
    add.push(`reg.exe add "${hive}\\Software\\Microsoft\\Edge\\SmartScreenPuaEnabled" /ve /t REG_DWORD /d 0 /f`);
    add.push(`reg.exe add "${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\AppHost" /v EnableWebContentEvaluation /t REG_DWORD /d 0 /f`);
    add.push(`reg.exe add "${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\AppHost" /v PreventOverride /t REG_DWORD /d 0 /f`);
  }
  const shownIcons = DESKTOP_ICONS.filter((icon) => config.desktopIcons?.[icon.id]);
  if (shownIcons.length) {
    for (const key of ["ClassicStartMenu", "NewStartPanel"]) {
      for (const icon of DESKTOP_ICONS) {
        add.push(
          `reg.exe add "${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\HideDesktopIcons\\${key}" /v "${icon.guid}" /t REG_DWORD /d ${config.desktopIcons?.[icon.id] ? 0 : 1} /f`,
        );
      }
    }
  }
  if (config.startFoldersCustom) {
    const bytes = START_FOLDERS.filter((folder) => config.startFolders?.[folder.id]).map((folder) => folder.bytes).join("");
    if (bytes) {
      add.push(
        `powershell.exe -NoProfile -Command "Set-ItemProperty -Path 'HKU:\\DefaultUser\\Software\\Microsoft\\Windows\\CurrentVersion\\Start' -Name VisiblePlaces -Value ([convert]::FromBase64String('${bytes}')) -Type Binary;"`,
      );
    }
  }
  const layoutXml = taskbarXml(config);
  if (layoutXml) {
    const file = embedSetupFile("TaskbarLayoutModification.xml", layoutXml);
    before.push(...file.cmds);
    add.push(`reg.exe add "${hive}\\Software\\Policies\\Microsoft\\Windows\\Explorer" /v StartLayoutFile /t REG_SZ /d "${file.dest}" /f`);
    add.push(`reg.exe add "${hive}\\Software\\Policies\\Microsoft\\Windows\\Explorer" /v LockedStartLayout /t REG_DWORD /d 1 /f`);
  }
  if (config.showAllTray) {
    const xml = embedSetupFile("ShowAllTrayIcons.xml", texts["ShowAllTrayIcons.xml"]);
    const ps1 = embedSetupFile("ShowAllTrayIcons.ps1", texts["ShowAllTrayIcons.ps1"]);
    before.push(...xml.cmds, ...ps1.cmds);
    add.push(`powershell.exe -NoProfile -ExecutionPolicy Unrestricted -File "${ps1.dest}"`);
  }
  add.push(...extraAdds);
  if (!add.length) return before;
  return [...before, load, ...add, unload];
}

export function machineCommands(config) {
  const cmds = [];
  if (config.bypassNetwork) {
    cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\OOBE" /v BypassNRO /t REG_DWORD /d 1 /f`);
  }
  if (config.enableLongPaths) {
    cmds.push(`reg.exe add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f`);
  }
  if (config.disableUac) {
    cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v EnableLUA /t REG_DWORD /d 0 /f`);
  }
  if (config.disableSmartScreen) {
    cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer" /v SmartScreenEnabled /t REG_SZ /d Off /f`);
    cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System" /v EnableSmartScreen /t REG_DWORD /d 0 /f`);
    cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WTDS\\Components" /v ServiceEnabled /t REG_DWORD /d 0 /f`);
    cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WTDS\\Components" /v NotifyMalicious /t REG_DWORD /d 0 /f`);
    cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WTDS\\Components" /v NotifyPasswordReuse /t REG_DWORD /d 0 /f`);
    cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WTDS\\Components" /v NotifyUnsafeApp /t REG_DWORD /d 0 /f`);
    cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender Security Center\\Systray" /v HideSystray /t REG_DWORD /d 1 /f`);
  }
  if (config.disableSac) {
    cmds.push(`reg.exe add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy" /v VerifiedAndReputablePolicyState /t REG_DWORD /d 0 /f`);
  }
  if (config.preventBitlocker) {
    cmds.push(`reg.exe add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\BitLocker" /v PreventDeviceEncryption /t REG_DWORD /d 1 /f`);
  }
  if (config.hideEdgeFre) {
    cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge" /v HideFirstRunExperience /t REG_DWORD /d 1 /f`);
  }
  if (config.disableEdgeBoost) {
    cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\Recommended" /v StartupBoostEnabled /t REG_DWORD /d 0 /f`);
    cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\Recommended" /v BackgroundModeEnabled /t REG_DWORD /d 0 /f`);
  }
  if (config.disableAppSuggestions) {
    cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\CloudContent" /v DisableWindowsConsumerFeatures /t REG_DWORD /d 1 /f`);
  }
  if (config.disableFastStartup) {
    cmds.push(`reg.exe add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power" /v HiberbootEnabled /t REG_DWORD /d 0 /f`);
  }
  if (config.enableRdp) {
    cmds.push(`reg.exe add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f`);
    cmds.push(`netsh.exe advfirewall firewall set rule group="@FirewallAPI.dll,-28752" new enable=Yes`);
  }
  if (config.disableSystemRestore) {
    cmds.push(`powershell.exe -NoProfile -Command "Disable-ComputerRestore -Drive 'C:\\';"`);
  }
  if (config.passwordExpire === "never") cmds.push(`net.exe accounts /maxpwage:unlimited`);
  else if (config.passwordExpire === "custom") cmds.push(`net.exe accounts /maxpwage:${Number(config.passwordExpireDays) || 42}`);
  if (config.lockout === "disable") cmds.push(`net.exe accounts /lockoutthreshold:0`);
  else if (config.lockout === "custom") {
    cmds.push(
      `net.exe accounts /lockoutthreshold:${Number(config.lockoutThreshold) || 10} /lockoutwindow:${Number(config.lockoutWindow) || 10} /lockoutduration:${Number(config.lockoutDuration) || 10}`,
    );
  }
  if (config.disableCoreIsolation) {
    cmds.push(`reg.exe add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard" /v EnableVirtualizationBasedSecurity /t REG_DWORD /d 0 /f`);
    cmds.push(`reg.exe add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity" /v Enabled /t REG_DWORD /d 0 /f`);
    cmds.push(`reg.exe add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity" /v EnabledBootId /t REG_DWORD /d 0 /f`);
    cmds.push(`reg.exe add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity" /v WasEnabledBy /t REG_DWORD /d 0 /f`);
  }
  if (config.disableWpbt) {
    cmds.push(`reg.exe add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager" /v DisableWpbtExecution /t REG_DWORD /d 1 /f`);
  }
  if (config.disableAutoSignOn) {
    cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v DisableAutomaticRestartSignOn /t REG_DWORD /d 1 /f`);
  }
  if (config.preventDeviceApps) {
    cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\DeviceSetup" /v DisableUserPnpDeviceInstall /t REG_DWORD /d 1 /f`);
  }
  if (config.disableLastAccess) {
    cmds.push(`fsutil.exe behavior set disableLastAccess 1`);
  }
  if (config.hardenAcl) {
    cmds.push(`icacls.exe C:\\ /remove:g "*S-1-5-11"`);
  }
  if (config.deleteJunctions) {
    cmds.push(`cmd.exe /c "rd /q \\"C:\\Documents and Settings\\" & rd /q \\"C:\\Users\\Default\\My Documents\\""`);
  }
  if (config.deleteWindowsOld) {
    cmds.push(`cmd.exe /c "if exist C:\\Windows.old rd /s /q C:\\Windows.old"`);
  }
  if (config.allowPsScripts) {
    cmds.push(`powershell.exe -NoProfile -Command "Set-ExecutionPolicy -Scope LocalMachine -ExecutionPolicy RemoteSigned -Force;"`);
  }
  if (config.processAudit) {
    cmds.push(`auditpol.exe /set /subcategory:"{0CCE922B-69AE-11D9-BED3-505054503030}" /success:enable /failure:enable`);
    if (config.processAuditCmdline !== false) {
      cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\Audit" /v ProcessCreationIncludeCmdLine_Enabled /t REG_DWORD /d 1 /f`);
    }
  }
  if (config.disableWindowsUpdate) {
    const file = embedSetupFile("PauseWindowsUpdate.xml", texts["PauseWindowsUpdate.xml"]);
    cmds.push(...file.cmds);
    cmds.push(`powershell.exe -NoProfile -Command "Register-ScheduledTask -TaskName PauseWindowsUpdate -Xml (Get-Content -LiteralPath '${file.dest}' -Raw);"`);
  }
  if (config.preventReboot) {
    cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU" /v AUOptions /t REG_DWORD /d 4 /f`);
    cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU" /v NoAutoRebootWithLoggedOnUsers /t REG_DWORD /d 1 /f`);
    const file = embedSetupFile("MoveActiveHours.xml", texts["MoveActiveHours.xml"]);
    cmds.push(...file.cmds);
    cmds.push(`powershell.exe -NoProfile -Command "Register-ScheduledTask -TaskName MoveActiveHours -Xml (Get-Content -LiteralPath '${file.dest}' -Raw);"`);
  }
  if (config.makeEdgeUninstallable) {
    const file = embedSetupFile("MakeEdgeUninstallable.ps1", texts["MakeEdgeUninstallable.ps1"]);
    cmds.push(...file.cmds, `powershell.exe -NoProfile -ExecutionPolicy Unrestricted -File "${file.dest}"`);
  }
  if (config.disableDefenderPe && !usesPeLater(config)) {
    cmds.push(`reg.exe add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender Security Center\\Notifications" /v DisableNotifications /t REG_DWORD /d 1 /f`);
    for (const svc of ["Sense", "WdBoot", "WdFilter", "WdNisDrv", "WdNisSvc", "WinDefend"]) {
      cmds.push(`reg.exe add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\${svc}" /v Start /t REG_DWORD /d 4 /f`);
    }
  }
  if (config.disable8dot3 && !usesPeLater(config)) {
    cmds.push(`fsutil.exe 8dot3name set C: 1`);
    cmds.push(`reg.exe add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v NtfsDisable8dot3NameCreation /t REG_DWORD /d 1 /f`);
  }
  if (config.geoId) {
    cmds.push(`powershell.exe -NoProfile -Command "Set-WinHomeLocation -GeoId ${Number(config.geoId) || 134};"`);
  }
  if (config.timeZoneMode === "explicit" && config.timeZone) {
    cmds.push(`tzutil.exe /s "${config.timeZone}"`);
  }
  if (config.computerNameMode === "script" && config.computerNameScript.trim()) {
    const getter = embedSetupFile("GetComputerName.ps1", config.computerNameScript.trim());
    const setter = embedSetupFile("SetComputerName.ps1", texts["SetComputerName.ps1"]);
    cmds.push(...getter.cmds, ...setter.cmds);
    cmds.push(
      `powershell.exe -NoProfile -Command "& '${getter.dest}' | Set-Content 'C:\\Windows\\Setup\\Scripts\\ComputerName.txt'; Start-Process powershell.exe -ArgumentList '-ExecutionPolicy Unrestricted -NoProfile -File ${setter.dest}' -WindowStyle Hidden; Start-Sleep 10;"`,
    );
  }
  if (config.startPins === "none" || (config.startPins === "json" && config.startPinsJson.trim())) {
    const json = config.startPins === "none" ? '{"pinnedList":[]}' : config.startPinsJson.trim().replace(/'/g, "''");
    const file = embedSetupFile("SetStartPins.ps1", `$json = '${json}';\n${texts["SetStartPins.ps1"]}`);
    cmds.push(...file.cmds, `powershell.exe -NoProfile -ExecutionPolicy Unrestricted -File "${file.dest}"`);
  }
  const tiles = startTilesXml(config);
  if (tiles) {
    const file = embedSetupFile("LayoutModification.xml", tiles);
    cmds.push(...file.cmds);
    cmds.push(
      `cmd.exe /c "mkdir C:\\Users\\Default\\AppData\\Local\\Microsoft\\Windows\\Shell 2>nul & copy /y ${file.dest} C:\\Users\\Default\\AppData\\Local\\Microsoft\\Windows\\Shell\\LayoutModification.xml"`,
    );
  }
  if (taskbarXml(config)) {
    const vbs = embedSetupFile("UnlockStartLayout.vbs", texts["UnlockStartLayout.vbs"]);
    const task = embedSetupFile("UnlockStartLayout.xml", texts["UnlockStartLayout.xml"]);
    cmds.push(...vbs.cmds, ...task.cmds);
    cmds.push(`reg.exe add "HKLM\\Software\\Policies\\Microsoft\\Windows\\CloudContent" /v DisableCloudOptimizedContent /t REG_DWORD /d 1 /f`);
    cmds.push(
      `powershell.exe -NoProfile -Command "[System.Diagnostics.EventLog]::CreateEventSource('UnattendGenerator','Application'); Register-ScheduledTask -TaskName UnlockStartLayout -Xml (Get-Content -LiteralPath '${task.dest}' -Raw);"`,
    );
  }
  const pairs = effectPairs(config);
  if (pairs.length) {
    for (const [id, on] of pairs) {
      cmds.push(
        `powershell.exe -NoProfile -Command "Set-ItemProperty -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects\\${id}' -Name DefaultValue -Value ${on ? 1 : 0} -Type DWord -Force;"`,
      );
    }
  }
  if (config.lockKeys) {
    cmds.push(
      `powershell.exe -NoProfile -Command "Set-ItemProperty -LiteralPath 'Registry::HKU\\.DEFAULT\\Control Panel\\Keyboard' -Name InitialKeyboardIndicators -Type String -Value ${lockIndicators(config)} -Force;"`,
    );
    const scancode = scancodeMapBase64(config);
    if (scancode) {
      cmds.push(
        `powershell.exe -NoProfile -Command "Set-ItemProperty -LiteralPath 'Registry::HKLM\\SYSTEM\\CurrentControlSet\\Control\\Keyboard Layout' -Name 'Scancode Map' -Type Binary -Value ([convert]::FromBase64String('${scancode}'));"`,
      );
    }
  }
  if (config.stickyKeys === "disable" || config.stickyKeys === "custom") {
    cmds.push(`reg.exe add "HKU\\.DEFAULT\\Control Panel\\Accessibility\\StickyKeys" /v Flags /t REG_SZ /d ${stickyFlags(config)} /f`);
  }
  if (config.narrator) {
    cmds.push(`cmd.exe /c "start C:\\Windows\\System32\\Narrator.exe"`);
    cmds.push(`reg.exe add "HKLM\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Accessibility" /v Configuration /t REG_SZ /d narrator /f`);
  }
  if (config.appLocker.trim()) {
    cmds.push(
      `powershell.exe -NoProfile -Command "$p='C:\\Windows\\Setup\\Scripts\\AppLocker.xml'; New-Item (Split-Path $p) -ItemType Directory -Force | Out-Null; Set-Content -Path $p -Value @'${config.appLocker.trim().replace(/'/g, "''")}'@; Set-AppLockerPolicy -XmlPolicy $p;"`,
    );
  }
  if (config.wallpaperMode === "script" && config.wallpaperScript.trim()) {
    const getter = embedSetupFile("GetWallpaper.ps1", config.wallpaperScript.trim());
    cmds.push(...getter.cmds);
    cmds.push(
      `powershell.exe -NoProfile -Command "try { $bytes = & '${getter.dest}'; [IO.File]::WriteAllBytes('C:\\Windows\\Setup\\Scripts\\Wallpaper', $bytes) } catch { $_ }"`,
    );
  }
  if (config.lockScreenMode === "script" && config.lockScreenScript.trim()) {
    const getter = embedSetupFile("GetLockScreenImage.ps1", config.lockScreenScript.trim());
    cmds.push(...getter.cmds);
    cmds.push(
      `powershell.exe -NoProfile -Command "try { $bytes = & '${getter.dest}'; [IO.File]::WriteAllBytes('C:\\Windows\\Setup\\Scripts\\LockScreenImage', $bytes); reg.exe add 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\PersonalizationCSP' /v LockScreenImagePath /t REG_SZ /d 'C:\\Windows\\Setup\\Scripts\\LockScreenImage' /f } catch { $_ }"`,
    );
  }
  return cmds;
}

function usesPeLater(config) {
  return config.peStage === "generate" || config.peStage === "script";
}

export function firstLogonExtras(config) {
  const cmds = [];
  if (config.autoLogon !== "none" && config.accountMode === "local") {
    cmds.push(
      `powershell.exe -NoProfile -Command "Set-ItemProperty -LiteralPath 'Registry::HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon' -Name AutoLogonCount -Type DWord -Force -Value 0;"`,
    );
  }
  if (config.deleteEdgeShortcut) {
    cmds.push(`cmd.exe /c del /f /q "%PUBLIC%\\Desktop\\Microsoft Edge.lnk"`);
  }
  if (config.startPins === "none") {
    cmds.push(
      `powershell.exe -NoProfile -Command "New-Item 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\Explorer' -Force | Out-Null; reg.exe add HKCU\\Software\\Policies\\Microsoft\\Windows\\Explorer /v HideRecentlyAddedApps /t REG_DWORD /d 1 /f;"`,
    );
  }
  if (taskbarXml(config)) {
    cmds.push(
      `powershell.exe -NoProfile -Command "[System.Diagnostics.EventLog]::WriteEntry('UnattendGenerator', 'User requested to unlock the Start menu layout.', [System.Diagnostics.EventLogEntryType]::Information, 1);"`,
    );
  }
  const fx = visualFxSetting(config);
  if (fx) {
    cmds.push(
      `powershell.exe -NoProfile -Command "Set-ItemProperty -LiteralPath 'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects' -Name VisualFXSetting -Type DWord -Value ${fx} -Force;"`,
    );
  }
  if (!config.keepSensitiveFiles) {
    cmds.push(`cmd.exe /c "del /f /q C:\\Windows\\Panther\\unattend.xml C:\\Windows\\Panther\\unattend-original.xml C:\\Windows\\Setup\\Scripts\\Wifi.xml"`);
  }
  if (config.colorMode === "custom") {
    const lightSys = config.themeSystem === "light" ? 1 : 0;
    const lightApps = config.themeApps === "light" ? 1 : 0;
    const file = embedSetupFile(
      "SetColorTheme.ps1",
      `$lightThemeSystem = ${lightSys};\n$lightThemeApps = ${lightApps};\n$accentColorOnStart = ${config.accentOnStart ? 1 : 0};\n$enableTransparency = ${config.enableTransparency ? 1 : 0};\n$htmlAccentColor = '${config.accentColor || "#0078D4"}';\n${texts["SetColorTheme.ps1"]}`,
    );
    cmds.push(...file.cmds, `powershell.exe -NoProfile -ExecutionPolicy Unrestricted -File "${file.dest}"`);
  }
  if (config.wallpaperMode === "solid" || config.wallpaperMode === "script") {
    const setter = embedSetupFile("SetWallpaper.ps1", texts["SetWallpaper.ps1"]);
    cmds.push(...setter.cmds);
    if (config.wallpaperMode === "solid") {
      cmds.push(
        `powershell.exe -NoProfile -Command ". '${setter.dest}'; Set-WallpaperColor -HtmlColor '${config.wallpaperColor || "#000000"}';"`,
      );
    } else {
      cmds.push(
        `powershell.exe -NoProfile -Command ". '${setter.dest}'; Set-WallpaperImage -LiteralPath 'C:\\Windows\\Setup\\Scripts\\Wallpaper';"`,
      );
    }
  }
  const guests = [];
  if (config.vboxGuest) guests.push(["VBoxGuestAdditions.ps1", texts["VBoxGuestAdditions.ps1"]]);
  if (config.vmwareTools) guests.push(["VMwareTools.ps1", texts["VMwareTools.ps1"]]);
  if (config.virtio) guests.push(["VirtIoGuestTools.ps1", texts["VirtIoGuestTools.ps1"]]);
  if (config.parallels) guests.push(["ParallelsTools.ps1", texts["ParallelsTools.ps1"]]);
  for (const [name, body] of guests) {
    const file = embedSetupFile(name, body);
    cmds.push(...file.cmds, `powershell.exe -NoProfile -ExecutionPolicy Unrestricted -File "${file.dest}"`);
  }
  if (config.narrator) {
    cmds.push(`cmd.exe /c "start C:\\Windows\\System32\\Narrator.exe"`);
    cmds.push(`reg.exe add "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Accessibility" /v Configuration /t REG_SZ /d narrator /f`);
  }
  if (config.restartExplorer) cmds.push(`cmd.exe /c "taskkill /f /im explorer.exe & start explorer.exe"`);
  return cmds;
}
