import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const dir = dirname(fileURLToPath(import.meta.url));
const json = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));

function bloatId(item) {
  return "Remove" + (item.Token || item.DisplayName.replace(/ /g, ""));
}

function stepKind(type) {
  if (String(type).includes("PackageBloatwareStep")) return "package";
  if (String(type).includes("CapabilityBloatwareStep")) return "capability";
  if (String(type).includes("OptionalFeatureBloatwareStep")) return "feature";
  return "custom";
}

const bloatware = json("Bloatware.json").map((item) => ({
  id: bloatId(item),
  name: item.DisplayName,
  steps: (item.Steps || []).map((s) => ({
    kind: stepKind(s.$type),
    selector: s.Selector || "",
  })),
}));

const data = {
  imageLanguages: json("ImageLanguage.json").map((x) => ({ id: x.Id, name: x.DisplayName })),
  locales: json("UserLocale.json").map((x) => ({
    id: x.Id,
    name: x.DisplayName,
    lcid: x.LCID,
    keyboard: x.KeyboardLayout,
    geo: x.GeoLocation,
  })),
  keyboards: json("KeyboardIdentifier.json").map((x) => ({ id: x.Id, name: x.DisplayName })),
  geoIds: json("GeoId.json").map((x) => ({ id: String(x.Id), name: x.DisplayName })),
  timeZones: json("TimeOffset.json").map((x) => ({ id: x.Id, name: x.DisplayName })),
  editions: json("WindowsEdition.json")
    .filter((x) => x.Visible !== false)
    .map((x) => ({ id: x.Id, name: x.DisplayName, key: x.ProductKey })),
  components: json("Component.json").map((x) => ({ id: x.Id, passes: x.Passes })),
  desktopIcons: json("DesktopIcon.json").map((x) => ({
    id: x.Id,
    name: x.DisplayName,
    guid: x.Guid,
  })),
  startFolders: json("StartFolder.json").map((x) => ({
    id: x.DisplayName.replace(/ /g, ""),
    name: x.DisplayName,
    bytes: x.Bytes,
  })),
  bloatware,
};

writeFileSync(join(dir, "..", "catalog-data.js"), `export default ${JSON.stringify(data)};\n`, "utf8");

const textNames = [
  "RemoveBloatware.ps1",
  "SetStartPins.ps1",
  "SetColorTheme.ps1",
  "SetWallpaper.ps1",
  "SetComputerName.ps1",
  "PauseWindowsUpdate.xml",
  "MoveActiveHours.xml",
  "ShowAllTrayIcons.ps1",
  "ShowAllTrayIcons.xml",
  "UnlockStartLayout.xml",
  "UnlockStartLayout.vbs",
  "MakeEdgeUninstallable.ps1",
  "VBoxGuestAdditions.ps1",
  "VMwareTools.ps1",
  "VirtIoGuestTools.ps1",
  "ParallelsTools.ps1",
  "RestartExplorer.ps1",
  "WLANProfile.xml",
];
const texts = {};
for (const name of textNames) texts[name] = readFileSync(join(dir, name), "utf8");
writeFileSync(join(dir, "..", "vendor-text.js"), `export default ${JSON.stringify(texts)};\n`, "utf8");
console.log("wrote catalog-data.js", Object.keys(data).map((k) => `${k}:${data[k].length}`).join(" "));
console.log("wrote vendor-text.js", textNames.length);
