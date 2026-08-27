import { BLOATWARE } from "./catalog.js";
import { embedSetupFile } from "./embed.js";
import texts from "./vendor-text.js";

function removerScript(kind, selectors) {
  const get =
    kind === "package"
      ? "{ Get-AppxProvisionedPackage -Online; }"
      : kind === "capability"
        ? "{ Get-WindowsCapability -Online | Where-Object -Property 'State' -NotIn -Value @('NotPresent';'Removed'); }"
        : "{ Get-WindowsOptionalFeature -Online | Where-Object -Property 'State' -NotIn -Value @('Disabled';'DisabledWithPayloadRemoved'); }";
  const filter =
    kind === "package"
      ? "{ $_.DisplayName -eq $selector; }"
      : kind === "capability"
        ? "{ ($_.Name -split '~')[0] -eq $selector; }"
        : "{ $_.FeatureName -eq $selector; }";
  const remove =
    kind === "package"
      ? "{ [CmdletBinding()] param([Parameter(Mandatory, ValueFromPipeline)]$InputObject); process { $InputObject | Remove-AppxProvisionedPackage -AllUsers -Online -ErrorAction 'Continue'; } }"
      : kind === "capability"
        ? "{ [CmdletBinding()] param([Parameter(Mandatory, ValueFromPipeline)]$InputObject); process { $InputObject | Remove-WindowsCapability -Online -ErrorAction 'Continue'; } }"
        : "{ [CmdletBinding()] param([Parameter(Mandatory, ValueFromPipeline)]$InputObject); process { $InputObject | Disable-WindowsOptionalFeature -Online -Remove -NoRestart -ErrorAction 'Continue'; } }";
  const type = kind === "package" ? "Package" : kind === "capability" ? "Capability" : "Feature";
  const base = kind === "package" ? "RemovePackages" : kind === "capability" ? "RemoveCapabilities" : "RemoveFeatures";
  const list = selectors.map((s) => `\t'${s.replace(/'/g, "''")}';`).join("\n");
  return `$selectors = @(\n${list}\n);\n$getCommand = ${get};\n$filterCommand = ${filter};\n$removeCommand = ${remove};\n$type = '${type}';\n$logfile = 'C:\\Windows\\Setup\\Scripts\\${base}.log';\n${texts["RemoveBloatware.ps1"]}`;
}

export function bloatCommands(config) {
  const selected = BLOATWARE.filter((item) => config.bloatware?.[item.id]);
  if (!selected.length) return { specialize: [], defaultUser: [], userOnce: [] };
  const packages = [];
  const capabilities = [];
  const features = [];
  const specialize = [];
  const defaultUser = [];
  const userOnce = [];

  for (const item of selected) {
    for (const step of item.steps) {
      if (step.kind === "package" && step.selector) packages.push(step.selector);
      else if (step.kind === "capability" && step.selector) capabilities.push(step.selector);
      else if (step.kind === "feature" && step.selector) features.push(step.selector);
    }
    switch (item.id) {
      case "RemoveOneDrive":
        specialize.push(
          `powershell.exe -NoProfile -Command "Remove-Item -LiteralPath 'C:\\Users\\Default\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\OneDrive.lnk','C:\\Windows\\System32\\OneDriveSetup.exe','C:\\Windows\\SysWOW64\\OneDriveSetup.exe' -ErrorAction Continue;"`,
        );
        defaultUser.push(`reg.exe delete "HKU\\DefaultUser\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v OneDriveSetup /f`);
        break;
      case "RemoveTeams":
        specialize.push(`reg.exe add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Communications" /v ConfigureChatAutoInstall /t REG_DWORD /d 0 /f`);
        break;
      case "RemoveNotepad":
        specialize.push(`reg.exe add "HKCR\\.txt\\ShellNew" /v ItemName /t REG_EXPAND_SZ /d "@C:\\Windows\\system32\\notepad.exe,-470" /f`);
        specialize.push(`reg.exe add "HKCR\\.txt\\ShellNew" /v NullFile /t REG_SZ /f`);
        defaultUser.push(`reg.exe add "HKU\\DefaultUser\\Software\\Microsoft\\Notepad" /v ShowStoreBanner /t REG_DWORD /d 0 /f`);
        break;
      case "RemoveOutlook":
        specialize.push(
          `powershell.exe -NoProfile -Command "Remove-Item -LiteralPath 'Registry::HKLM\\Software\\Microsoft\\WindowsUpdate\\Orchestrator\\UScheduler_Oobe\\OutlookUpdate' -Force -EA SilentlyContinue;"`,
        );
        break;
      case "RemoveDevHome":
        specialize.push(
          `powershell.exe -NoProfile -Command "Remove-Item -LiteralPath 'Registry::HKLM\\Software\\Microsoft\\WindowsUpdate\\Orchestrator\\UScheduler_Oobe\\DevHomeUpdate' -Force -EA SilentlyContinue;"`,
        );
        break;
      case "RemoveCopilot":
        userOnce.push(`powershell.exe -NoProfile -Command "Get-AppxPackage -Name 'Microsoft.Windows.Ai.Copilot.Provider' | Remove-AppxPackage;"`);
        defaultUser.push(`reg.exe add "HKU\\DefaultUser\\Software\\Policies\\Microsoft\\Windows\\WindowsCopilot" /v TurnOffWindowsCopilot /t REG_DWORD /d 1 /f`);
        break;
      case "RemoveXboxApps":
        defaultUser.push(`reg.exe add "HKU\\DefaultUser\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR" /v AppCaptureEnabled /t REG_DWORD /d 0 /f`);
        break;
      case "RemoveInternetExplorer":
        defaultUser.push(`reg.exe add "HKU\\DefaultUser\\Software\\Microsoft\\Internet Explorer\\LowRegistry\\Audio\\PolicyConfig\\PropertyStore" /f`);
        break;
      default:
        break;
    }
  }

  const add = (kind, list, name) => {
    if (!list.length) return;
    const unique = [...new Set(list)];
    const file = embedSetupFile(`${name}.ps1`, removerScript(kind, unique));
    specialize.push(...file.cmds);
    specialize.push(`powershell.exe -NoProfile -ExecutionPolicy Unrestricted -File "${file.dest}"`);
  };
  add("package", packages, "RemovePackages");
  add("capability", capabilities, "RemoveCapabilities");
  add("feature", features, "RemoveFeatures");
  return { specialize, defaultUser, userOnce };
}
