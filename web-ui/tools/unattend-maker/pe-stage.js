import { dropAndRunPe } from "./embed.js";
import { EDITIONS } from "./catalog.js";

function editionDisplay(config) {
  return EDITIONS.find((e) => e.id === config.edition)?.name || "Pro";
}

function diskpartLines(config, layout) {
  const custom = String(config.customDiskpart || "").trim();
  if (config.diskMode === "custom" && custom) {
    return custom.replace(/\r\n/g, "\n").split("\n").filter((line) => line.length);
  }
  const disk = Number(config.targetDisk) || 0;
  const sys = Number(config.systemPartitionMb) || 300;
  const rec = Number(config.recoveryMb) || 1000;
  const recovery = config.recoveryMode === "partition";
  if (layout === "mbr") {
    const lines = [
      `SELECT DISK=${disk}`,
      "CLEAN",
      `CREATE PARTITION PRIMARY SIZE=${sys}`,
      'FORMAT QUICK FS=NTFS LABEL="System"',
      "ASSIGN LETTER=S",
      "ACTIVE",
      "CREATE PARTITION PRIMARY",
    ];
    if (recovery) lines.push(`SHRINK MINIMUM=${rec}`);
    lines.push('FORMAT QUICK FS=NTFS LABEL="Windows"', "ASSIGN LETTER=W");
    if (recovery) {
      lines.push("CREATE PARTITION PRIMARY", 'FORMAT QUICK FS=NTFS LABEL="Recovery"', "ASSIGN LETTER=R", "SET ID=27");
    }
    return lines;
  }
  const lines = [
    `SELECT DISK=${disk}`,
    "CLEAN",
    "CONVERT GPT",
    `CREATE PARTITION EFI SIZE=${sys}`,
    'FORMAT QUICK FS=FAT32 LABEL="System"',
    "ASSIGN LETTER=S",
    "CREATE PARTITION MSR SIZE=16",
    "CREATE PARTITION PRIMARY",
  ];
  if (recovery) lines.push(`SHRINK MINIMUM=${rec}`);
  lines.push('FORMAT QUICK FS=NTFS LABEL="Windows"', "ASSIGN LETTER=W");
  if (recovery) {
    lines.push(
      "CREATE PARTITION PRIMARY",
      'FORMAT QUICK FS=NTFS LABEL="Recovery"',
      "ASSIGN LETTER=R",
      'SET ID="de94bba4-06d1-4d40-a16a-bfd50179d6ac"',
      "GPT ATTRIBUTES=0x8000000000000001",
    );
  }
  return lines;
}

function echoBlock(path, lines) {
  const out = [`>${path} (`];
  for (const line of lines) {
    if (!line) continue;
    out.push(`\techo ${line.replace(/([()<>|&^])/g, "^$1")}`);
  }
  out.push(")");
  return out;
}

function assertionVbs(config) {
  if (config.assertDisk === "script") {
    return String(config.assertScript || "").replace(/\r\n/g, "\n").split("\n");
  }
  if (config.assertDisk !== "generated") return [];
  const disk = Number(config.targetDisk) || 0;
  const lines = [
    "Function Fail(message)",
    "  WScript.Echo message",
    "  WScript.Quit 1",
    "End Function",
    "On Error Resume Next",
    'Set wmi = GetObject("winmgmts:\\\\.\\root\\cimv2")',
    `Set drive = wmi.Get("Win32_DiskDrive.DeviceID='\\\\.\\PHYSICALDRIVE${disk}'")`,
    "If Err.Number <> 0 Then",
    `  Fail "Could not locate disk ${disk} (" & Err.Description & ")."`,
    "End If",
  ];
  if (config.assertInterface) {
    lines.push(
      "actual = drive.InterfaceType",
      'If actual <> "IDE" And actual <> "SCSI" Then',
      `  Fail "InterfaceType '" & actual & "' of disk ${disk} is unexpected."`,
      "End If",
    );
  }
  if (config.assertMedia) {
    lines.push(
      "actual = drive.MediaType",
      'If actual <> "Fixed hard disk media" Then',
      `  Fail "MediaType '" & actual & "' of disk ${disk} is unexpected."`,
      "End If",
    );
  }
  if (config.assertMinGiB) {
    lines.push(
      "actual = CInt(drive.Size / 1024 / 1024 / 1024)",
      `expected = ${Number(config.assertMinGiB)}`,
      "If actual < expected Then",
      `  Fail "Size of disk ${disk} is expected to be at least " & expected & " GiB, but actually is " & actual & " GiB."`,
      "End If",
    );
  }
  if (config.assertMaxGiB) {
    lines.push(
      "actual = CInt(drive.Size / 1024 / 1024 / 1024)",
      `expected = ${Number(config.assertMaxGiB)}`,
      "If actual > expected Then",
      `  Fail "Size of disk ${disk} is expected to be at most " & expected & " GiB, but actually is " & actual & " GiB."`,
      "End If",
    );
  }
  if (config.assertNoPartitions) {
    lines.push(
      "actual = drive.Partitions",
      "If actual > 0 Then",
      `  Fail "There are already " & actual & " partitions on disk ${disk}."`,
      "End If",
    );
  }
  lines.push('WScript.Echo "Disk assertions were satisfied."', "WScript.Quit 0");
  return lines;
}

function imgParam(config) {
  if (config.imageSelect === "index") return `set "IMG_PARAM=/Index:${Number(config.imageIndex) || 1}"`;
  if (config.imageSelect === "name" && String(config.imageName || "").trim()) {
    return `set "IMG_PARAM=/Name:"${String(config.imageName).trim().replace(/"/g, "")}""`;
  }
  if (config.imageSelect === "interactive") {
    return [
      'dism.exe /Get-WimInfo /WimFile:"%IMAGE_FILE%"',
      "echo:",
      ":choice",
      'set /p "CHOICE=Enter index of the image you want to install: " || goto :choice',
      'set "IMG_PARAM=/Index:%CHOICE%"',
    ];
  }
  return `set "IMG_PARAM=/Name:"Windows %OS_VERSION% ${editionDisplay(config)}""`;
}

export function peScriptText(config) {
  const keyboard = `${(config.keyboardLc || "0412")}:${config.keyboard || "00000412"}`;
  const verify = config.skipIntegrity ? "" : " /CheckIntegrity /Verify";
  const compact = config.compactOs ? " /Compact" : "";
  const layout = config.partitionLayout === "mbr" ? "mbr" : config.partitionLayout === "gpt" ? "gpt" : "auto";
  const lines = [
    "@echo off",
    "setlocal EnableExtensions",
    `call :print "Setting keyboard layout for PE session"`,
    `wpeutil.exe SetKeyboardLayout ${keyboard}`,
    "for %%d in (C D E F G H I J K L M N O P Q T U V X Y Z) do (",
    '  if exist %%d:\\sources\\install.wim set "IMAGE_FILE=%%d:\\sources\\install.wim"',
    '  if exist %%d:\\sources\\install.esd set "IMAGE_FILE=%%d:\\sources\\install.esd"',
    '  if exist %%d:\\sources\\install.swm set "IMAGE_FILE=%%d:\\sources\\install.swm" & set "SWM_PARAM=/SWMFile:%%d:\\sources\\install*.swm"',
    '  if exist %%d:\\autounattend.xml set "XML_FILE=%%d:\\autounattend.xml"',
    '  if exist %%d:\\$OEM$ set "OEM_FOLDER=%%d:\\$OEM$"',
    '  if exist %%d:\\$WinPEDriver$ set "PEDRIVERS_FOLDER=%%d:\\$WinPEDriver$"',
  ];
  if (config.virtio) lines.push('  if exist %%d:\\virtio-win-guest-tools.exe set "VIRTIO_DRIVE=%%d:"');
  lines.push(
    ")",
    "for /f \"tokens=3\" %%t in ('reg.exe query HKLM\\System\\Setup /v UnattendFile 2^>nul') do ( if exist %%t set \"XML_FILE=%%t\" )",
    "if not defined IMAGE_FILE call :fail \"Could not locate install.wim, install.esd or install.swm.\"",
    "if not defined XML_FILE call :fail \"Could not locate autounattend.xml.\"",
    'set "OS_VERSION=11"',
    "for /f \"tokens=3 delims=.\" %%v in ('ver') do ( if %%v LSS 20000 set OS_VERSION=10 )",
    "if defined PEDRIVERS_FOLDER (",
    '  call :print "Loading drivers from $WinPEDriver$ folder"',
    "  for /R %PEDRIVERS_FOLDER% %%f IN (*.inf) do drvload.exe \"%%f\"",
    ")",
  );
  if (config.virtio) {
    lines.push(
      "if defined VIRTIO_DRIVE (",
      '  call :print "Loading VirtIO drivers"',
      '  drvload.exe "%VIRTIO_DRIVE%\\vioscsi\\w%OS_VERSION%\\%PROCESSOR_ARCHITECTURE%\\vioscsi.inf"',
      '  drvload.exe "%VIRTIO_DRIVE%\\viostor\\w%OS_VERSION%\\%PROCESSOR_ARCHITECTURE%\\viostor.inf"',
      '  drvload.exe "%VIRTIO_DRIVE%\\NetKVM\\w%OS_VERSION%\\%PROCESSOR_ARCHITECTURE%\\netkvm.inf"',
      ")",
    );
  }
  const assert = assertionVbs(config);
  if (assert.length) {
    lines.push(...echoBlock("X:\\assert.vbs", assert));
    lines.push('call :print "Running disk assertions"');
    lines.push('cscript.exe //E:vbscript "X:\\assert.vbs" //Nologo || call :fail "Disk assertion failed. Windows Setup will halt to avoid potential data loss."');
  }
  if (config.diskMode === "diskpartInteractive") {
    lines.push(
      'call :print "Press Shift+F10 to open a console, then use diskpart. Assign W: to Windows and S: to the system partition."',
      "pause",
    );
  } else if (layout === "auto" && config.diskMode !== "custom") {
    lines.push(...echoBlock("X:\\GPT.txt", diskpartLines(config, "gpt")));
    lines.push(...echoBlock("X:\\MBR.txt", diskpartLines(config, "mbr")));
    lines.push(
      "wpeutil.exe UpdateBootInfo",
      "for /f \"tokens=3\" %%t in ('reg.exe query HKLM\\SYSTEM\\CurrentControlSet\\Control /v PEFirmwareType') do (",
      "  if %%t == 0x1 ( set \"LAYOUT=MBR\" ) else if %%t == 0x2 ( set \"LAYOUT=GPT\" ) else ( call :fail \"Unexpected value %%t.\" )",
      ")",
      'call :print "The target disk will be configured with the %LAYOUT% partition layout"',
    );
    if (config.pauseBeforeFormat) lines.push("pause");
    lines.push('diskpart.exe /s X:\\%LAYOUT%.txt || call :fail "diskpart.exe encountered an error."');
  } else {
    lines.push(...echoBlock("X:\\diskpart.txt", diskpartLines(config, layout === "mbr" ? "mbr" : "gpt")));
    if (config.pauseBeforeFormat) lines.push("pause");
    lines.push('diskpart.exe /s X:\\diskpart.txt || call :fail "diskpart.exe encountered an error."');
  }
  const img = imgParam(config);
  if (Array.isArray(img)) lines.push(...img);
  else lines.push(img);
  lines.push(
    'call :print "Applying Windows image to target disk"',
    `dism.exe /Apply-Image /ImageFile:%IMAGE_FILE% %SWM_PARAM% %IMG_PARAM% /ApplyDir:W:\\${compact}${verify} || call :fail "dism.exe encountered an error."`,
    'call :print "Making system partition bootable"',
    "bcdboot.exe W:\\Windows /s S: || call :fail \"bcdboot.exe encountered an error.\"",
    "bcdedit.exe /set {fwbootmgr} bootsequence {bootmgr}",
  );
  if (config.recoveryMode === "none") {
    lines.push("del W:\\Windows\\System32\\Recovery\\winre.wim");
  }
  lines.push(
    "mkdir W:\\Windows\\Panther",
    "copy %XML_FILE% W:\\Windows\\Panther\\unattend.xml",
    "if defined PEDRIVERS_FOLDER (",
    '  dism.exe /Add-Driver /Image:W:\\ /Driver:"%PEDRIVERS_FOLDER%" /Recurse',
    ")",
  );
  if (config.virtio) {
    lines.push(
      "if defined VIRTIO_DRIVE (",
      '  dism.exe /Add-Driver /Image:W:\\ /Driver:"%VIRTIO_DRIVE%\\vioscsi\\w%OS_VERSION%\\%PROCESSOR_ARCHITECTURE%\\vioscsi.inf"',
      '  dism.exe /Add-Driver /Image:W:\\ /Driver:"%VIRTIO_DRIVE%\\viostor\\w%OS_VERSION%\\%PROCESSOR_ARCHITECTURE%\\viostor.inf"',
      '  dism.exe /Add-Driver /Image:W:\\ /Driver:"%VIRTIO_DRIVE%\\NetKVM\\w%OS_VERSION%\\%PROCESSOR_ARCHITECTURE%\\netkvm.inf"',
      ")",
    );
  }
  if (config.timeZoneMode === "explicit" && config.timeZone) {
    lines.push(`dism.exe /Image:W:\\ /Set-TimeZone:"${config.timeZone}"`);
  }
  if (config.disable8dot3) {
    lines.push(
      "fsutil.exe 8dot3name set W: 1",
      "fsutil.exe 8dot3name strip /s /f W:\\",
      "reg.exe LOAD HKLM\\mount W:\\Windows\\System32\\config\\SYSTEM",
      "reg.exe ADD HKLM\\mount\\ControlSet001\\Control\\FileSystem /v NtfsDisable8dot3NameCreation /t REG_DWORD /d 1 /f",
      "reg.exe UNLOAD HKLM\\mount",
    );
  }
  if (config.disableDefenderPe) {
    lines.push(
      "reg.exe LOAD HKLM\\mount W:\\Windows\\System32\\config\\SYSTEM",
      "for %%s in (Sense WdBoot WdFilter WdNisDrv WdNisSvc WinDefend) do reg.exe ADD HKLM\\mount\\ControlSet001\\Services\\%%s /v Start /t REG_DWORD /d 4 /f",
      "reg.exe UNLOAD HKLM\\mount",
    );
  }
  if (config.disableWpbt) {
    lines.push(
      "reg.exe LOAD HKLM\\mount W:\\Windows\\System32\\config\\SYSTEM",
      'reg.exe add "HKLM\\mount\\ControlSet001\\Control\\Session Manager" /v DisableWpbtExecution /t REG_DWORD /d 1 /f',
      "reg.exe UNLOAD HKLM\\mount",
    );
  }
  if (config.geoId) {
    lines.push(
      "reg.exe LOAD HKLM\\mount W:\\Windows\\System32\\config\\SOFTWARE",
      `reg.exe ADD "HKLM\\mount\\Microsoft\\Windows\\CurrentVersion\\Control Panel\\DeviceRegion" /v DeviceRegion /t REG_DWORD /d ${Number(config.geoId) || 134} /f`,
      "reg.exe UNLOAD HKLM\\mount",
    );
  }
  if (config.useOemFolder) {
    lines.push(
      "set \"ROBOCOPY_ARGS=/E /XX /COPY:DAT /DCOPY:DAT /R:0\"",
      "if defined OEM_FOLDER (",
      '  if exist "%OEM_FOLDER%\\$$" robocopy.exe "%OEM_FOLDER%\\$$" W:\\Windows %ROBOCOPY_ARGS%',
      '  if exist "%OEM_FOLDER%\\$1" robocopy.exe "%OEM_FOLDER%\\$1" W:\\ %ROBOCOPY_ARGS%',
      ")",
    );
  }
  if (config.pauseBeforeReboot) lines.push("pause");
  lines.push(
    "wpeutil.exe reboot",
    "goto :eof",
    ":fail",
    "echo Fatal error: %~1",
    "pause",
    "exit 1",
    ":print",
    "echo *** %~1 ***",
    "goto :eof",
  );
  return `${lines.join("\r\n")}\r\n`;
}

export function usesPeApply(config) {
  return config.peStage === "generate" || config.peStage === "script";
}

export function peStageCommands(config) {
  const cmds = [];
  if (config.bypassTpm) {
    for (const name of ["BypassTPMCheck", "BypassSecureBootCheck", "BypassRAMCheck", "BypassStorageCheck", "BypassCPUCheck"]) {
      cmds.push(`reg.exe add "HKLM\\SYSTEM\\Setup\\LabConfig" /v ${name} /t REG_DWORD /d 1 /f`);
    }
    cmds.push(`reg.exe add "HKLM\\SYSTEM\\Setup\\MoSetup" /v BypassTPMCheck /t REG_DWORD /d 1 /f`);
  }
  if (config.narrator) {
    cmds.push(`cmd.exe /c start X:\\Windows\\System32\\Narrator.exe`);
  }
  if (config.peStage === "script" || String(config.customPeScript || "").trim()) {
    if (config.peStage === "script" || (usesPeApply(config) && String(config.customPeScript || "").trim() && config.peStage !== "generate")) {
      cmds.push(...dropAndRunPe(`${config.customPeScript.trim()}\r\n`, "X:\\pe.cmd"));
      return cmds;
    }
  }
  if (usesPeApply(config)) {
    cmds.push(...dropAndRunPe(peScriptText(config), "X:\\pe.cmd"));
  }
  return cmds;
}

export { editionDisplay };
