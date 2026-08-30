import { EDITIONS, inputLocale, localeById } from "./catalog.js";
import { bloatCommands } from "./bloat.js";
import { migrateConfig } from "./config.js";
import { obscurePassword } from "./embed.js";
import { peStageCommands, usesPeApply } from "./pe-stage.js";
import { scriptCommands } from "./scripts.js";
import { defaultHiveCommands, firstLogonExtras, machineCommands } from "./tweaks.js";
import { wifiSpecializeCommands } from "./wifi.js";

export const CONFIG_MARK = "ITMATZIP-UNATTEND-1";

function xmlEsc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlText(value) {
  return [...String(value)]
    .map((ch) => {
      const code = ch.codePointAt(0);
      if (code > 127) return `&#${code};`;
      if (ch === "&") return "&amp;";
      if (ch === "<") return "&lt;";
      if (ch === ">") return "&gt;";
      return ch;
    })
    .join("");
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function arches(config) {
  const list = [];
  if (config.archX86) list.push("x86");
  if (config.archAmd64) list.push("amd64");
  if (config.archArm64) list.push("arm64");
  return list.length ? list : ["amd64"];
}

function component(name, arch, inner) {
  return `    <component name="${name}" processorArchitecture="${arch}" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
${inner}
    </component>`;
}

function settings(pass, body) {
  return `  <settings pass="${pass}">
${body}
  </settings>`;
}

function editionKey(config) {
  if (config.productKeyMode === "custom" && config.productKey.trim()) {
    return config.productKey.trim().toUpperCase();
  }
  if (config.productKeyMode === "firmware") return "";
  const found = EDITIONS.find((item) => item.id === config.edition);
  return found ? found.key : EDITIONS.find((item) => item.id === "pro").key;
}

function inputList(config) {
  const primary = inputLocale(config.locale || config.imageLanguage || "ko-KR", config.keyboard);
  let extra = "";
  if (config.locale2 && config.keyboard2) extra += `;${inputLocale(config.locale2, config.keyboard2)}`;
  else if (config.keyboard2) extra += `;${config.keyboard2}`;
  if (config.locale3 && config.keyboard3) extra += `;${inputLocale(config.locale3, config.keyboard3)}`;
  else if (config.keyboard3) extra += `;${config.keyboard3}`;
  return primary + extra;
}

function userLocaleXml(config) {
  const input = inputList(config);
  const locale = config.locale || config.imageLanguage || "ko-KR";
  const lang = config.imageLanguage || "ko-KR";
  return `      <SetupUILanguage>
        <UILanguage>${xmlEsc(lang)}</UILanguage>
      </SetupUILanguage>
      <InputLocale>${xmlEsc(input)}</InputLocale>
      <SystemLocale>${xmlEsc(locale)}</SystemLocale>
      <UILanguage>${xmlEsc(lang)}</UILanguage>
      <UserLocale>${xmlEsc(locale)}</UserLocale>`;
}

function oobeLocaleXml(config) {
  const locale = config.locale || config.imageLanguage || "ko-KR";
  const lang = config.imageLanguage || "ko-KR";
  const input = inputList(config);
  return `      <InputLocale>${xmlEsc(input)}</InputLocale>
      <SystemLocale>${xmlEsc(locale)}</SystemLocale>
      <UILanguage>${xmlEsc(lang)}</UILanguage>
      <UserLocale>${xmlEsc(locale)}</UserLocale>`;
}

function runSyncXml(cmds) {
  if (!cmds.length) return "";
  return `      <RunSynchronous>
${cmds
  .map(
    (path, index) => `        <RunSynchronousCommand wcm:action="add">
          <Order>${index + 1}</Order>
          <Path>${xmlEsc(path)}</Path>
        </RunSynchronousCommand>`,
  )
  .join("\n")}
      </RunSynchronous>`;
}

function productKeyXml(config) {
  if (config.productKeyMode === "interactive") return "";
  if (config.productKeyMode === "firmware") {
    return `        <ProductKey>
          <Key></Key>
          <WillShowUI>OnError</WillShowUI>
        </ProductKey>`;
  }
  const key = editionKey(config);
  return `        <ProductKey>
          <Key>${xmlEsc(key)}</Key>
          <WillShowUI>OnError</WillShowUI>
        </ProductKey>`;
}

function diskXml(config) {
  if (config.diskMode === "interactive") {
    return `        <DiskConfiguration>
          <WillShowUI>Always</WillShowUI>
        </DiskConfiguration>
        <ImageInstall>
          <OSImage>
            <InstallToAvailablePartition>false</InstallToAvailablePartition>
            <WillShowUI>OnError</WillShowUI>
          </OSImage>
        </ImageInstall>`;
  }

  const disk = Number(config.targetDisk) || 0;
  const layout = config.partitionLayout === "mbr" ? "mbr" : "gpt";
  const recovery = config.recoveryMode === "partition";
  const sysSize = Number(config.systemPartitionMb) || 300;
  const recSize = Number(config.recoveryMb) || 1000;

  if (layout === "mbr") {
    const winId = recovery ? 2 : 2;
    const create = recovery
      ? `            <CreatePartition wcm:action="add">
              <Order>1</Order>
              <Type>Primary</Type>
              <Size>${sysSize}</Size>
            </CreatePartition>
            <CreatePartition wcm:action="add">
              <Order>2</Order>
              <Type>Primary</Type>
              <Extend>true</Extend>
            </CreatePartition>`
      : `            <CreatePartition wcm:action="add">
              <Order>1</Order>
              <Type>Primary</Type>
              <Size>${sysSize}</Size>
            </CreatePartition>
            <CreatePartition wcm:action="add">
              <Order>2</Order>
              <Type>Primary</Type>
              <Extend>true</Extend>
            </CreatePartition>`;
    return `        <DiskConfiguration>
          <Disk wcm:action="add">
            <DiskID>${disk}</DiskID>
            <WillWipeDisk>true</WillWipeDisk>
            <CreatePartitions>
${create}
            </CreatePartitions>
            <ModifyPartitions>
              <ModifyPartition wcm:action="add">
                <Order>1</Order>
                <PartitionID>1</PartitionID>
                <Label>System</Label>
                <Format>NTFS</Format>
                <Active>true</Active>
              </ModifyPartition>
              <ModifyPartition wcm:action="add">
                <Order>2</Order>
                <PartitionID>2</PartitionID>
                <Label>Windows</Label>
                <Letter>C</Letter>
                <Format>NTFS</Format>
              </ModifyPartition>
            </ModifyPartitions>
          </Disk>
          <WillShowUI>OnError</WillShowUI>
        </DiskConfiguration>
        <ImageInstall>
          <OSImage>
            <InstallTo>
              <DiskID>${disk}</DiskID>
              <PartitionID>${winId}</PartitionID>
            </InstallTo>
          </OSImage>
        </ImageInstall>`;
  }

  const create = recovery
    ? `            <CreatePartition wcm:action="add">
              <Order>1</Order>
              <Type>Primary</Type>
              <Size>${recSize}</Size>
            </CreatePartition>
            <CreatePartition wcm:action="add">
              <Order>2</Order>
              <Type>EFI</Type>
              <Size>${sysSize}</Size>
            </CreatePartition>
            <CreatePartition wcm:action="add">
              <Order>3</Order>
              <Type>MSR</Type>
              <Size>16</Size>
            </CreatePartition>
            <CreatePartition wcm:action="add">
              <Order>4</Order>
              <Type>Primary</Type>
              <Extend>true</Extend>
            </CreatePartition>`
    : `            <CreatePartition wcm:action="add">
              <Order>1</Order>
              <Type>EFI</Type>
              <Size>${sysSize}</Size>
            </CreatePartition>
            <CreatePartition wcm:action="add">
              <Order>2</Order>
              <Type>MSR</Type>
              <Size>16</Size>
            </CreatePartition>
            <CreatePartition wcm:action="add">
              <Order>3</Order>
              <Type>Primary</Type>
              <Extend>true</Extend>
            </CreatePartition>`;

  const modify = recovery
    ? `              <ModifyPartition wcm:action="add">
                <Order>1</Order>
                <PartitionID>1</PartitionID>
                <Label>Recovery</Label>
                <Format>NTFS</Format>
                <TypeID>de94bba4-06d1-4d40-a16a-bfd50179d6ac</TypeID>
              </ModifyPartition>
              <ModifyPartition wcm:action="add">
                <Order>2</Order>
                <PartitionID>2</PartitionID>
                <Label>System</Label>
                <Format>FAT32</Format>
              </ModifyPartition>
              <ModifyPartition wcm:action="add">
                <Order>3</Order>
                <PartitionID>3</PartitionID>
              </ModifyPartition>
              <ModifyPartition wcm:action="add">
                <Order>4</Order>
                <PartitionID>4</PartitionID>
                <Label>Windows</Label>
                <Letter>C</Letter>
                <Format>NTFS</Format>
              </ModifyPartition>`
    : `              <ModifyPartition wcm:action="add">
                <Order>1</Order>
                <PartitionID>1</PartitionID>
                <Label>System</Label>
                <Format>FAT32</Format>
              </ModifyPartition>
              <ModifyPartition wcm:action="add">
                <Order>2</Order>
                <PartitionID>2</PartitionID>
              </ModifyPartition>
              <ModifyPartition wcm:action="add">
                <Order>3</Order>
                <PartitionID>3</PartitionID>
                <Label>Windows</Label>
                <Letter>C</Letter>
                <Format>NTFS</Format>
              </ModifyPartition>`;

  const winPart = recovery ? 4 : 3;
  return `        <DiskConfiguration>
          <Disk wcm:action="add">
            <DiskID>${disk}</DiskID>
            <WillWipeDisk>true</WillWipeDisk>
            <CreatePartitions>
${create}
            </CreatePartitions>
            <ModifyPartitions>
${modify}
            </ModifyPartitions>
          </Disk>
          <WillShowUI>OnError</WillShowUI>
        </DiskConfiguration>
        <ImageInstall>
          <OSImage>
            <InstallTo>
              <DiskID>${disk}</DiskID>
              <PartitionID>${winPart}</PartitionID>
            </InstallTo>
          </OSImage>
        </ImageInstall>`;
}

function passwordXml(password, obscure, element = "Password") {
  const value = password || "";
  if (obscure && value) {
    return `          <${element}>
            <Value>${xmlEsc(obscurePassword(value, element))}</Value>
            <PlainText>false</PlainText>
          </${element}>`;
  }
  return `          <${element}>
            <Value>${xmlEsc(value)}</Value>
            <PlainText>true</PlainText>
          </${element}>`;
}

function namedAccounts(config) {
  const rows = Array.isArray(config.accounts) ? config.accounts : [];
  const out = rows.filter((a) => String(a?.name || "").trim());
  if (out.length) return out;
  if (config.accountName?.trim()) {
    return [
      {
        name: config.accountName.trim(),
        display: config.accountDisplay,
        password: config.accountPassword,
        group: config.accountGroup || "Administrators",
      },
    ];
  }
  return [];
}

function userAccountsXml(config) {
  if (config.accountMode !== "local") return "";
  const accounts = namedAccounts(config);
  if (!accounts.length && config.autoLogon !== "builtin-admin") return "";
  let xml = `        <UserAccounts>`;
  if (config.autoLogon === "builtin-admin") {
    xml += `
${passwordXml(config.builtinAdminPassword, config.obscurePasswords, "AdministratorPassword")}`;
  }
  if (accounts.length) {
    xml += `
        <LocalAccounts>`;
    for (const acc of accounts) {
      const name = acc.name.trim();
      const display = (acc.display || name).trim();
      xml += `
          <LocalAccount wcm:action="add">
            <Name>${xmlText(name)}</Name>
            <DisplayName>${xmlText(display)}</DisplayName>
            <Group>${xmlEsc(acc.group || "Users")}</Group>
${passwordXml(acc.password, config.obscurePasswords, "Password")}
          </LocalAccount>`;
    }
    xml += `
        </LocalAccounts>`;
  }
  xml += `
        </UserAccounts>`;
  return xml;
}

function oobeXml(config) {
  const hideOnline = config.accountMode === "local" || config.accountMode === "interactive-local" || config.bypassNetwork;
  const hideWireless =
    config.wifiMode === "profile" ? "" : `\n          <HideWirelessSetupInOOBE>${config.wifiMode === "skip" ? "true" : "false"}</HideWirelessSetupInOOBE>`;
  const protect =
    config.expressSettings === "disable" ? 3 : config.expressSettings === "enable" ? 1 : 3;
  const hideLocal = config.accountMode === "local";
  return `        <OOBE>
          <HideEULAPage>true</HideEULAPage>
          <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
          <HideOnlineAccountScreens>${hideOnline ? "true" : "false"}</HideOnlineAccountScreens>${hideWireless}
          <HideLocalAccountScreen>${hideLocal ? "true" : "false"}</HideLocalAccountScreen>
          <ProtectYourPC>${protect}</ProtectYourPC>
          <NetworkLocation>Work</NetworkLocation>
        </OOBE>`;
}

function autoLogonXml(config) {
  if (config.autoLogon === "none") return "";
  if (config.accountMode !== "local") return "";
  const first = namedAccounts(config)[0];
  const name =
    config.autoLogon === "builtin-admin" ? "Administrator" : (first?.name || config.accountName || "User").trim() || "User";
  const password =
    config.autoLogon === "builtin-admin" ? config.builtinAdminPassword : first?.password || config.accountPassword;
  return `        <AutoLogon>
          <Enabled>true</Enabled>
          <Username>${xmlText(name)}</Username>
          <LogonCount>1</LogonCount>
${passwordXml(password, config.obscurePasswords)}
        </AutoLogon>`;
}

function firstLogonCommands(commands) {
  if (!commands.length) return "";
  return `        <FirstLogonCommands>
${commands
  .map(
    (cmd, index) => `          <SynchronousCommand wcm:action="add">
            <Order>${index + 1}</Order>
            <RequiresUserInput>false</RequiresUserInput>
            <CommandLine>${xmlEsc(cmd)}</CommandLine>
          </SynchronousCommand>`,
  )
  .join("\n")}
        </FirstLogonCommands>`;
}

function specializeCommands(commands) {
  return runSyncXml(commands);
}

function extraComponentBlocks(config, archList) {
  const bag = config.componentXml || {};
  const blocks = [];
  for (const [key, markup] of Object.entries(bag)) {
    const xml = String(markup || "").trim();
    if (!xml) continue;
    const [pass, name] = key.split("|");
    if (!pass || !name || /<(settings|component)\b/i.test(xml)) continue;
    for (const arch of archList) {
      blocks.push({ pass, xml: component(name, arch, `      ${xml}`) });
    }
  }
  return blocks;
}

export function generateXml(config) {
  config = migrateConfig(config);
  const loc = localeById(config.locale || config.imageLanguage || "ko-KR");
  if (config.peStage === "setup") config = { ...config, diskMode: "interactive" };
  config = { ...config, keyboardLc: loc?.lcid || "0412" };
  const archList = arches(config);
  const payload = toBase64(JSON.stringify(config));
  const peRun = runSyncXml(peStageCommands(config));
  const compact = config.compactOs && !usesPeApply(config) ? `\n          <Compact>true</Compact>` : "";
  const diskBlock = usesPeApply(config) ? "" : `${diskXml(config)}\n`;
  const oem = config.useOemFolder && !usesPeApply(config) ? `\n        <UseConfigurationSet>true</UseConfigurationSet>` : "";

  const peSetupInner = `${diskBlock}        <UserData>
          <AcceptEula>true</AcceptEula>
${productKeyXml(config)}
        </UserData>${oem}${compact}${peRun ? `\n${peRun}` : ""}`;

  const peBlocks = archList
    .map((arch) => {
      let block = "";
      if (!config.languageInteractive) {
        block += component("Microsoft-Windows-International-Core-WinPE", arch, userLocaleXml(config));
        block += "\n";
      }
      block += component("Microsoft-Windows-Setup", arch, peSetupInner);
      return block;
    })
    .join("\n");

  const bloat = bloatCommands(config);
  const scripts = scriptCommands(config);
  const specCmds = [
    ...defaultHiveCommands(config, [...bloat.defaultUser, ...scripts.defaultUser]),
    ...machineCommands(config),
    ...wifiSpecializeCommands(config),
    ...bloat.specialize,
    ...scripts.system,
  ];
  const specInner = [];
  if (config.computerNameMode === "custom" && config.computerName.trim()) {
    specInner.push(`      <ComputerName>${xmlText(config.computerName.trim())}</ComputerName>`);
  } else if (config.computerNameMode === "script" && config.computerNameScript.trim()) {
    specInner.push(`      <ComputerName>TEMPNAME</ComputerName>`);
  }
  if (config.timeZoneMode === "explicit") {
    specInner.push(`      <TimeZone>${xmlEsc(config.timeZone)}</TimeZone>`);
  }

  const extraComps = extraComponentBlocks(config, archList);
  const specExtras = extraComps.filter((c) => c.pass === "specialize").map((c) => c.xml).join("\n");

  const specBlocks = archList
    .map((arch) => {
      let xml = "";
      if (specInner.length) {
        xml += component("Microsoft-Windows-Shell-Setup", arch, specInner.join("\n"));
      }
      if (specCmds.length) {
        xml += (xml ? "\n" : "") + component("Microsoft-Windows-Deployment", arch, specializeCommands(specCmds));
      }
      return xml;
    })
    .filter(Boolean)
    .concat(specExtras)
    .join("\n");

  const logonCmds = [];
  logonCmds.push(...firstLogonExtras(config));
  logonCmds.push(...bloat.userOnce);
  logonCmds.push(...scripts.firstLogon);
  logonCmds.push(...scripts.userOnce);

  const oobeInner = [];
  oobeInner.push(oobeXml(config));
  if (config.accountMode === "local") {
    oobeInner.push(userAccountsXml(config));
    oobeInner.push(autoLogonXml(config));
  }
  oobeInner.push(firstLogonCommands(logonCmds));
  if (config.activationKey.trim() && config.productKeyMode !== "custom") {
    oobeInner.push(`        <ProductKey>${xmlEsc(config.activationKey.trim())}</ProductKey>`);
  }

  const oobeExtras = extraComps.filter((c) => c.pass === "oobeSystem").map((c) => c.xml).join("\n");
  const oobeBlocks = archList
    .map((arch) => {
      let xml = "";
      if (!config.languageInteractive) {
        xml += component("Microsoft-Windows-International-Core", arch, oobeLocaleXml(config));
      }
      xml += (xml ? "\n" : "") + component("Microsoft-Windows-Shell-Setup", arch, oobeInner.filter(Boolean).join("\n"));
      return xml;
    })
    .concat(oobeExtras)
    .join("\n");

  const otherPasses = {};
  for (const item of extraComps) {
    if (item.pass === "specialize" || item.pass === "oobeSystem" || item.pass === "windowsPE") continue;
    otherPasses[item.pass] = (otherPasses[item.pass] || "") + (otherPasses[item.pass] ? "\n" : "") + item.xml;
  }
  const otherXml = Object.entries(otherPasses)
    .map(([pass, body]) => `\n${settings(pass, body)}`)
    .join("");
  const extra = config.extraXml.trim() ? `\n${config.extraXml.trim()}\n` : "";

  return `<?xml version="1.0" encoding="utf-8"?>
<!--${CONFIG_MARK}:${payload}-->
<unattend xmlns="urn:schemas-microsoft-com:unattend">
${settings("windowsPE", peBlocks)}
${specBlocks ? settings("specialize", specBlocks) + "\n" : ""}${settings("oobeSystem", oobeBlocks)}${otherXml}${extra}
</unattend>
`;
}

function parseErr(key, fallback) {
  try {
    if (typeof window !== "undefined" && window.itzT) return window.itzT(key, fallback);
  } catch (e) {}
  return fallback;
}

export function parseSavedXml(text) {
  if (!text || typeof text !== "string") {
    throw new Error(parseErr("err.emptyFile", "빈 파일입니다."));
  }
  const match = text.match(new RegExp(`<!--${CONFIG_MARK}:([A-Za-z0-9+/=]+)-->`));
  if (!match) {
    throw new Error(parseErr("err.notFromTool", "이 도구에서 받은 파일만 다시 불러올 수 있습니다."));
  }
  let parsed;
  try {
    parsed = JSON.parse(fromBase64(match[1]));
  } catch {
    throw new Error(parseErr("err.corrupt", "저장 정보를 읽지 못했습니다. 파일이 손상되었을 수 있습니다."));
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(parseErr("err.badFormat", "설정 형식이 올바르지 않습니다."));
  }
  return migrateConfig(parsed);
}

export function downloadName(config) {
  return config.downloadName === "notautounattend.xml" ? "notautounattend.xml" : "autounattend.xml";
}
