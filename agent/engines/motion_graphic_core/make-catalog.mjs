// node agent/engines/motion_graphic_core/make-catalog.mjs — mg-core.js 의 스타일·템플릿·효과 목록을 Python 용 JSON 으로
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STYLES, TEMPLATE_META, OVERLAY_FX } from "./src/mg-core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = {
  styles: Object.fromEntries(Object.entries(STYLES).map(([id, s]) => [id, { label: s.label, desc: s.desc, colors: s.C }])),
  templates: TEMPLATE_META,
  overlay_fx: OVERLAY_FX,
};
fs.writeFileSync(path.join(here, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
console.log("catalog.json", Object.keys(catalog.styles).length, "styles", TEMPLATE_META.length, "templates");
