import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = "e:/Develop Program/1. AutoSubtitle/src/shared/subtitleWordEdgeDrag.ts";
const dst = path.resolve(__dirname, "../shared/subtitle-word-edge-drag.js");

let s = fs.readFileSync(src, "utf8");
s = s.replace(/import type[^;]+;/g, "");
s = s.replace(/export type ApplyWordEdgeDragInput = \{[\s\S]*?\}\n\n/g, "");
s = s.replace(/export type EdgeDragResult = \{[\s\S]*?\}\n\n/g, "");
s = s.replace(/export type WordRef = \{[\s\S]*?\}\n\n/g, "");
s = s.replace(/export type ActiveLinkedWord = FlatWord & \{[\s\S]*?\}\n\n/g, "");
s = s.replace(/export type FlatWord = \{[\s\S]*?\}\n\n/g, "");
s = s.replace(/export type WordEdge = 'start' \| 'end'\n\n/g, "");
s = s.replace(/ as const/g, "");
s = s.replace(/readonly /g, "");
s = s.replace(/: readonly string\[\]/g, "");
s = s.replace(/: readonly FlatWord\[\]/g, "");
s = s.replace(/: readonly SubtitleLine\[\]/g, "");
s = s.replace(/: readonly ActiveLinkedWord\[\]/g, "");
s = s.replace(/: Map<string, number>/g, "");
s = s.replace(/: WordEdge/g, "");
s = s.replace(/: ApplyWordEdgeDragInput/g, "");
s = s.replace(/: EdgeDragResult/g, "");
s = s.replace(/: FlatWord\[\]/g, "");
s = s.replace(/: ActiveLinkedWord\[\]/g, "");
s = s.replace(/: SubtitleWord\[\]/g, "");
s = s.replace(/: SubtitleLine\[\]/g, "");
s = s.replace(/: WordRef\[\]/g, "");
s = s.replace(/: SubtitleLine/g, "");
s = s.replace(/: SubtitleWord/g, "");
s = s.replace(/: FlatWord/g, "");
s = s.replace(/: ActiveLinkedWord/g, "");
s = s.replace(/: WordRef/g, "");
s = s.replace(/: number/g, "");
s = s.replace(/: boolean/g, "");
s = s.replace(/: string/g, "");

const header = `/**
 * AutoSubtitle subtitleWordEdgeDrag.ts (ported)
 */
import { wordIsDeleted } from "./subtitles.js";

`;

fs.writeFileSync(dst, header + s);
console.log("ok", dst);
