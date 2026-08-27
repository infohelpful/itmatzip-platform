import { embedSetupFile, runByType } from "./embed.js";

const PHASES = ["system", "defaultUser", "firstLogon", "userOnce"];

export function scriptCommands(config) {
  const out = { system: [], defaultUser: [], firstLogon: [], userOnce: [] };
  const slots = config.scriptSlots || {};
  let index = 0;
  for (const phase of PHASES) {
    for (const slot of slots[phase] || []) {
      const content = String(slot.content || "").trim();
      if (!content) continue;
      index += 1;
      const type = slot.type || "ps1";
      const name = `unattend-${String(index).padStart(2, "0")}.${type}`;
      let body = content;
      if (type === "reg" && !body.startsWith("Windows Registry Editor")) {
        body = `Windows Registry Editor Version 5.00\r\n\r\n${body}`;
      }
      const file = embedSetupFile(name, body);
      out[phase].push(...file.cmds);
      out[phase].push(runByType(file.dest, type, config.hidePowerShell));
    }
  }
  if (config.scriptsSystem?.trim()) out.system.push(config.scriptsSystem.trim());
  if (config.scriptsDefaultUser?.trim()) out.defaultUser.push(config.scriptsDefaultUser.trim());
  if (config.scriptsFirstLogon?.trim()) out.firstLogon.push(config.scriptsFirstLogon.trim());
  if (config.scriptsUserOnce?.trim()) out.userOnce.push(config.scriptsUserOnce.trim());
  return out;
}
