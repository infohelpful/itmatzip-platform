import { embedSetupFile, xmlEsc } from "./embed.js";
import texts from "./vendor-text.js";

function toHex(text) {
  return [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function buildWifiProfile(config) {
  if (config.wifiXml?.trim()) return config.wifiXml.trim();
  const name = config.wifiSsid.trim();
  const auth = config.wifiAuth || "WPA2PSK";
  const hex = toHex(name);
  const hidden = config.wifiHidden ? "\n\t\t<nonBroadcast>true</nonBroadcast>" : "";
  const mode = config.wifiConnectAuto === false ? "manual" : "auto";
  if (auth === "open") {
    return `<WLANProfile xmlns='http://www.microsoft.com/networking/WLAN/profile/v1'>
	<name>${xmlEsc(name)}</name>
	<SSIDConfig>
		<SSID>
			<hex>${hex}</hex>
			<name>${xmlEsc(name)}</name>
		</SSID>${hidden}
	</SSIDConfig>
	<connectionType>ESS</connectionType>
	<connectionMode>${mode}</connectionMode>
	<MSM>
		<security>
			<authEncryption>
				<authentication>open</authentication>
				<encryption>none</encryption>
				<useOneX>false</useOneX>
			</authEncryption>
		</security>
	</MSM>
</WLANProfile>`;
  }
  const transition =
    auth === "WPA3SAE"
      ? `\n\t\t\t\t<transitionMode xmlns="http://www.microsoft.com/networking/WLAN/profile/v4">true</transitionMode>`
      : "";
  return texts["WLANProfile.xml"]
    .replaceAll("WLAN-1234", xmlEsc(name))
    .replace("574C414E2D31323334", hex)
    .replace("<connectionMode>auto</connectionMode>", `<connectionMode>${mode}</connectionMode>`)
    .replace("<authentication>WPA2PSK</authentication>", `<authentication>${auth}</authentication>`)
    .replace("<keyMaterial>secret</keyMaterial>", `<keyMaterial>${xmlEsc(config.wifiPassword || "")}</keyMaterial>`)
    .replace("</SSID>", `</SSID>${hidden}`)
    .replace("</useOneX>", `</useOneX>${transition}`);
}

export function wifiSpecializeCommands(config) {
  if (config.wifiMode !== "profile" || (!config.wifiSsid.trim() && !config.wifiXml.trim())) return [];
  const xml = buildWifiProfile(config);
  const file = embedSetupFile("Wifi.xml", xml);
  const name = config.wifiSsid.trim() || "WiFi";
  const cmds = [...file.cmds];
  cmds.push(
    `powershell.exe -NoProfile -Command "$name='WlanSvc'; $timeout=(Get-Date).AddMinutes(1); while((Get-Date) -lt $timeout){ $s=Get-Service $name -EA SilentlyContinue; if($s.Status -eq 'Running'){ break }; Start-Sleep 5 }; netsh.exe wlan add profile filename='${file.dest}' user=all;"`,
  );
  if (config.wifiConnectAuto !== false) {
    cmds.push(`netsh.exe wlan connect name="${name.replace(/"/g, "")}" ssid="${name.replace(/"/g, "")}"`);
  }
  return cmds;
}
