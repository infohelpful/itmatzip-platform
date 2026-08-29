/* global JSONRepair, JSONPath, JsoncParser */
importScripts("./vendor/jsonrepair.min.js", "./vendor/jsonpath-plus.umd.js", "./vendor/jsonc-parser.umd.js");

const MAX_ISSUES = 2000;
const LINT_MAX = 8 * 1024 * 1024;
const JSONC_OPTS = { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false };

const PEC = {
  InvalidSymbol: 1,
  InvalidNumberFormat: 2,
  PropertyNameExpected: 3,
  ValueExpected: 4,
  ColonExpected: 5,
  CommaExpected: 6,
  CloseBraceExpected: 7,
  CloseBracketExpected: 8,
  EndOfFileExpected: 9,
  InvalidCommentToken: 10,
  UnexpectedEndOfComment: 11,
  UnexpectedEndOfString: 12,
  UnexpectedEndOfNumber: 13,
  InvalidUnicode: 14,
  InvalidEscapeCharacter: 15,
  InvalidCharacter: 16,
};

function lineCol(text, position) {
  const pos = Math.max(0, Math.min(Number(position) || 0, text.length));
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos; i++) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, column: col, position: pos };
}

function parsePosition(message, text) {
  const m = String(message).match(/position\s+(\d+)/i);
  if (m) return Number(m[1]);
  return text.length;
}

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const loc = lineCol(text, parsePosition(err && err.message, text));
    return { ok: false, error: err instanceof Error ? err.message : String(err), ...loc };
  }
}

function makeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineColAt(starts, pos) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: pos - starts[lo] + 1, position: pos };
}

function jsoncParseErrors(text) {
  const errors = [];
  if (typeof JsoncParser === "undefined" || typeof JsoncParser.parse !== "function") return errors;
  JsoncParser.parse(text, errors, JSONC_OPTS);
  return errors;
}

function collapseJsoncErrors(errors) {
  const sorted = (errors || []).slice().sort((a, b) => a.offset - b.offset || a.error - b.error);
  const out = [];
  for (const err of sorted) {
    const prev = out[out.length - 1];
    const len = Math.max(1, Number(err.length) || 1);
    if (prev && err.offset === prev.offset && err.error === prev.error) continue;
    out.push({ error: err.error, offset: err.offset, length: len });
  }
  return out;
}

function findPrevStringStart(text, from) {
  let i = from - 1;
  while (i >= 0 && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i -= 1;
  if (text[i] !== '"') return -1;
  for (let j = i - 1; j >= 0; j--) {
    if (text[j] !== '"') continue;
    let bs = 0;
    for (let k = j - 1; k >= 0 && text[k] === "\\"; k--) bs += 1;
    if (bs % 2 === 0) return j;
  }
  return -1;
}

function expandJsoncRange(text, err) {
  const start0 = Math.max(0, Math.min(text.length, Number(err.offset) || 0));
  let end = Math.max(start0 + 1, Math.min(text.length, start0 + Math.max(1, Number(err.length) || 1)));
  let start = start0;
  const ch = text[start0] || "";
  if (ch === ":" && (err.error === PEC.CommaExpected || err.error === PEC.ValueExpected || err.error === PEC.InvalidSymbol)) {
    const strStart = findPrevStringStart(text, start0);
    if (strStart >= 0) return { start: strStart, end: start0, code: "missingBrace" };
  }
  if (err.error === PEC.PropertyNameExpected) {
    if (/[A-Za-z_$]/.test(ch)) {
      while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) end += 1;
      return { start, end, code: "unquotedKey" };
    }
    if (ch === "'" || ch.charCodeAt(0) === 8216 || ch.charCodeAt(0) === 8217) {
      return { start: start0, end: start0 + 1, code: "quotes" };
    }
    if (ch === ",") return { start: start0, end: start0 + 1, code: "missingValue" };
  }
  if (err.error === PEC.InvalidSymbol && (ch === "'" || ch.charCodeAt(0) === 8216 || ch.charCodeAt(0) === 8217)) {
    return { start: start0, end: start0 + 1, code: "quotes" };
  }
  if (err.error === PEC.InvalidSymbol && /[A-Za-z_$]/.test(ch)) {
    while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) end += 1;
    const word = text.slice(start, end);
    if (word === "True" || word === "False" || word === "None") return { start, end, code: "python" };
    if (text[end] === ":" || /^\s*:/.test(text.slice(end))) return { start, end, code: "unquotedKey" };
    return { start, end, code: "unquotedValue" };
  }
  if ((err.error === PEC.PropertyNameExpected || err.error === PEC.ValueExpected) && (ch === "}" || ch === "]")) {
    let i = start0 - 1;
    while (i >= 0 && /\s/.test(text[i])) i -= 1;
    if (text[i] === ",") return { start: i, end: i + 1, code: "trailingComma" };
  }
  return { start, end, code: jsoncCode(err.error, ch) };
}

function jsoncCode(error, ch) {
  switch (error) {
    case PEC.InvalidSymbol:
      return ch === "'" ? "quotes" : "unquotedKey";
    case PEC.InvalidNumberFormat:
    case PEC.UnexpectedEndOfNumber:
      return "badNumber";
    case PEC.PropertyNameExpected:
      return "unquotedKey";
    case PEC.ValueExpected:
      return "missingValue";
    case PEC.ColonExpected:
      return "missingColon";
    case PEC.CommaExpected:
      return ch === ":" ? "missingBrace" : "missingComma";
    case PEC.CloseBraceExpected:
    case PEC.CloseBracketExpected:
      return "unclosed";
    case PEC.EndOfFileExpected:
      return "trailingJunk";
    case PEC.InvalidCommentToken:
    case PEC.UnexpectedEndOfComment:
      return "comments";
    case PEC.UnexpectedEndOfString:
      return "unterminated";
    case PEC.InvalidUnicode:
    case PEC.InvalidEscapeCharacter:
    case PEC.InvalidCharacter:
      return "parse";
    default:
      return "parse";
  }
}

function scanTokenIssues(text, push) {
  if (typeof JsoncParser === "undefined" || typeof JsoncParser.createScanner !== "function") return;
  const Kind = JsoncParser.SyntaxKind;
  const ScanErr = JsoncParser.ScanError;
  const scanner = JsoncParser.createScanner(text, false);

  let kind = scanner.scan();
  while (kind !== Kind.EOF) {
    const offset = scanner.getTokenOffset();
    const len = scanner.getTokenLength();
    const end = offset + Math.max(1, len);
    const err = scanner.getTokenError();
    const raw = text.slice(offset, end);

    if (err === ScanErr.UnexpectedEndOfString) {
      push({ code: "unterminated", position: offset, end, message: "Unterminated string" });
    } else if (err === ScanErr.UnexpectedEndOfNumber || err === ScanErr.InvalidNumberFormat) {
      push({ code: "badNumber", position: offset, end, message: "Invalid number format" });
    } else if (err === ScanErr.InvalidCharacter || err === ScanErr.InvalidEscapeCharacter || err === ScanErr.InvalidUnicode) {
      push({ code: "parse", position: offset, end, message: "Invalid character or escape sequence" });
    }

    if (kind === Kind.LineCommentTrivia || kind === Kind.BlockCommentTrivia) {
      push({ code: "comments", position: offset, end, message: "Comments are not allowed in JSON" });
    } else if (kind === Kind.Unknown) {
      if (raw === "'" || raw.startsWith("'")) {
        push({ code: "quotes", position: offset, end, message: "Single quotes are not allowed in JSON" });
      } else if (raw === "True" || raw === "False" || raw === "None") {
        push({ code: "python", position: offset, end, message: `Python literal '${raw}'` });
      } else if (raw === "undefined" || raw === "NaN" || raw === "Infinity") {
        push({ code: "unquotedValue", position: offset, end, message: `Non-standard value '${raw}'` });
      } else if (/[A-Za-z_$]/.test(raw[0])) {
        push({ code: "unquotedKey", position: offset, end, message: `Unquoted key '${raw}'` });
      } else {
        push({ code: "unexpected", position: offset, end, message: `Unexpected token '${raw}'` });
      }
    } else if (kind === Kind.Comma) {
      const nextKind = scanner.scan();
      if (nextKind === Kind.CloseBraceToken || nextKind === Kind.CloseBracketToken) {
        push({ code: "trailingComma", position: offset, end: offset + 1, message: "Trailing comma" });
      }
      kind = nextKind;
      continue;
    }

    kind = scanner.scan();
  }
}

function scanIssues(text) {
  const issues = [];
  const seen = new Set();
  const starts = makeLineStarts(text);
  const push = (item) => {
    const start = Math.max(0, Math.min(text.length, Number(item.position) || 0));
    const end = Math.max(start + 1, Math.min(text.length, Number(item.end) || start + 1));
    const key = `${item.code}:${start}`;
    if (seen.has(key) || issues.length >= MAX_ISSUES) return;
    seen.add(key);
    const loc = item.line ? item : lineColAt(starts, start);
    issues.push({
      code: item.code,
      message: item.message || "",
      jsonc: item.jsonc || "",
      line: loc.line,
      column: loc.column,
      position: start,
      end,
    });
  };

  const parsed = tryParse(text);
  if (parsed.ok) return { parsed, issues };

  if (text.length <= LINT_MAX) {
    try {
      scanTokenIssues(text, push);
      const raw = collapseJsoncErrors(jsoncParseErrors(text));
      for (const err of raw) {
        const range = expandJsoncRange(text, err);
        const name = typeof JsoncParser.printParseErrorCode === "function" ? JsoncParser.printParseErrorCode(err.error) : "";
        push({
          code: range.code,
          jsonc: name,
          position: range.start,
          end: range.end,
          message: name,
        });
      }
    } catch {
      /* jsonc parse is best-effort */
    }
  }

  if (!issues.length) {
    let start = parsed.position;
    let end = Math.min(text.length, start + 1);
    const raw = String(parsed.error || "");
    const tok = raw.match(/Unexpected token (\S)/);
    if (tok) end = Math.min(text.length, start + tok[1].length);
    if (/Unexpected end of JSON input/i.test(raw)) {
      start = Math.max(0, text.length - 12);
      end = text.length;
    }
    push({
      code: "parse",
      message: raw,
      position: start,
      end,
      line: parsed.line,
      column: parsed.column,
    });
  }

  issues.sort((a, b) => a.position - b.position);
  return { parsed, issues };
}

function addNote(notes, key) {
  if (key && !notes.includes(key)) notes.push(key);
}

function collectJsoncIssues(text) {
  const issues = [];
  const seen = new Set();
  try {
    for (const err of collapseJsoncErrors(jsoncParseErrors(text))) {
      const range = expandJsoncRange(text, err);
      const key = `${range.code}:${range.start}`;
      if (seen.has(key) || issues.length >= MAX_ISSUES) continue;
      seen.add(key);
      issues.push({ code: range.code, position: range.start, end: range.end });
    }
  } catch {
    /* best-effort */
  }
  return issues;
}

function preprocessRepair(text) {
  const notes = [];
  let s = String(text || "");
  if (s.charCodeAt(0) === 0xfeff) {
    s = s.slice(1);
    addNote(notes, "fixBom");
  }
  const trimmed = s.trim();
  const fence = trimmed.match(/```(?:json|jsonc|javascript|js)?[ \t]*\r?\n([\s\S]*?)\r?\n```/i);
  if (fence) {
    s = fence[1];
    addNote(notes, "fixMarkdown");
  } else {
    const whole = trimmed.match(/^```(?:json|jsonc|javascript|js)?\s*([\s\S]*?)\s*```$/i);
    if (whole) {
      s = whole[1];
      addNote(notes, "fixMarkdown");
    }
  }
  return { text: s, notes };
}

function rewriteLooseTokens(text) {
  const notes = [];
  if (typeof JsoncParser === "undefined" || typeof JsoncParser.createScanner !== "function") {
    return { text, notes };
  }
  const Kind = JsoncParser.SyntaxKind;
  const scanner = JsoncParser.createScanner(text, false);
  const edits = [];
  let kind = scanner.scan();
  while (kind !== Kind.EOF) {
    if (kind === Kind.Unknown) {
      const start = scanner.getTokenOffset();
      const end = start + scanner.getTokenLength();
      const raw = text.slice(start, end);
      if (raw === "True" || raw === "False" || raw === "None") {
        const repl = raw === "True" ? "true" : raw === "False" ? "false" : "null";
        edits.push({ start, end, insert: repl, note: "python" });
      } else if (raw === "undefined") {
        edits.push({ start, end, insert: "null", note: "fixUndefined" });
      } else if (raw === "NaN" || raw === "Infinity" || raw === "-Infinity") {
        edits.push({ start, end, insert: "null", note: "fixNan" });
      } else if (/^\+\d/.test(raw)) {
        edits.push({ start, end, insert: raw.slice(1), note: "fixNumber" });
      } else if (/^\.\d/.test(raw)) {
        edits.push({ start, end, insert: "0" + raw, note: "fixNumber" });
      }
    }
    kind = scanner.scan();
  }
  let out = text;
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    out = out.slice(0, e.start) + e.insert + out.slice(e.end);
    addNote(notes, e.note);
  }
  return { text: out, notes };
}

function applyMissingBraces(text) {
  let out = text;
  let n = 0;
  for (let round = 0; round < 12; round++) {
    const found = collectJsoncIssues(out).filter((item) => item.code === "missingBrace");
    if (!found.length) break;
    found.sort((a, b) => b.position - a.position);
    for (const iss of found) {
      out = out.slice(0, iss.position) + "{" + out.slice(iss.position);
      n += 1;
    }
  }
  return { text: out, n };
}

function closeUnclosedStructures(text) {
  let s = String(text || "");
  let inString = false;
  let escape = false;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else {
      if (ch === '"') {
        inString = true;
      } else if (ch === "{" || ch === "[") {
        stack.push(ch === "{" ? "}" : "]");
      } else if (ch === "}" || ch === "]") {
        if (stack.length && stack[stack.length - 1] === ch) {
          stack.pop();
        }
      }
    }
  }
  if (inString) s += '"';
  while (stack.length) {
    s += stack.pop();
  }
  return s;
}

function tryFixJSON(input) {
  let fixed = input.replace(/,(\s*[}\]])/g, "$1");
  fixed = fixed.replace(/'([^'\\]|\\.)*'/g, (m) => {
    const inner = m.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"');
    return '"' + inner + '"';
  });
  return fixed;
}

function wrapConcatenated(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return null;
  const glued = trimmed.replace(/}\s*{/g, "},{").replace(/]\s*\[/g, "],[");
  if (glued === trimmed) return null;
  return "[" + glued + "]";
}

function runJsonrepair(text) {
  if (typeof JSONRepair === "undefined" || typeof JSONRepair.jsonrepair !== "function") {
    throw new Error("jsonrepair");
  }
  return JSONRepair.jsonrepair(text);
}

function sanitizeLooseJson(text) {
  let s = String(text || "").trim();
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/^```(?:json|jsonc|javascript|js)?\s*/i, "").replace(/\s*```$/i, "");

  let out = "";
  let inDouble = false;
  let inSingle = false;
  let escape = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escape = true;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      out += ch;
    } else if (inSingle) {
      if (ch === "'") {
        inSingle = false;
        out += '"';
      } else if (ch === '"') {
        out += '\\"';
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') {
        inDouble = true;
        out += ch;
      } else if (ch === "'") {
        inSingle = true;
        out += '"';
      } else {
        out += ch;
      }
    }
  }
  if (inSingle) out += '"';
  if (inDouble) out += '"';
  s = out;

  out = "";
  inDouble = false;
  escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1] || "";
    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escape = true;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      out += ch;
    } else {
      if (ch === '"') {
        inDouble = true;
        out += ch;
      } else if (ch === "/" && next === "/") {
        while (i < s.length && s[i] !== "\n") i++;
        out += "\n";
      } else if (ch === "/" && next === "*") {
        i += 2;
        while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
        i++;
      } else {
        out += ch;
      }
    }
  }
  s = out;

  s = s.replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null")
    .replace(/\bundefined\b/g, "null")
    .replace(/\bNaN\b/g, "null")
    .replace(/\bInfinity\b/g, "null");

  s = s.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":');
  s = s.replace(/,\s*([}\]])/g, "$1");

  s = s.replace(/([}\]"\d])\s*([{\["A-Za-z_$])/g, (m, p1, p2) => {
    if ((p1 === "}" || p1 === "]") && (p2 === "{" || p2 === "[")) return `${p1}, ${p2}`;
    if (p1 === '"' && (p2 === '"' || p2 === '{' || p2 === '[')) return `${p1}, ${p2}`;
    return m;
  });

  return closeUnclosedStructures(s);
}

function repairBrokenJson(text, indent) {
  const original = String(text || "");
  const scan = scanIssues(original);
  const already = tryParse(original);
  if (already.ok) {
    return { ok: true, text: JSON.stringify(already.value, null, indent), repaired: false, notes: [], issues: [] };
  }

  const notes = [];
  const sanitized = sanitizeLooseJson(original);
  const parseSanitized = tryParse(sanitized);
  if (parseSanitized.ok) {
    return {
      ok: true,
      text: JSON.stringify(parseSanitized.value, null, indent),
      repaired: true,
      notes: repairNotes(original, sanitized, ["generic"]),
      issues: scan.issues,
    };
  }

  const pre = preprocessRepair(original);
  let work = pre.text;
  pre.notes.forEach((key) => addNote(notes, key));

  const loose = rewriteLooseTokens(work);
  work = loose.text;
  loose.notes.forEach((key) => addNote(notes, key));

  const braces = applyMissingBraces(work);
  work = braces.text;
  if (braces.n) addNote(notes, "fixMissingBrace");

  const parsedAfterBrace = tryParse(work);
  if (parsedAfterBrace.ok) {
    return {
      ok: true,
      text: JSON.stringify(parsedAfterBrace.value, null, indent),
      repaired: work !== original,
      notes: repairNotes(original, work, notes),
      issues: scan.issues,
    };
  }

  const closedWork = closeUnclosedStructures(sanitized);
  const candidates = [{ text: sanitized, extra: [] }, { text: closedWork, extra: [] }, { text: work, extra: [] }];
  const wrapped = wrapConcatenated(closedWork);
  if (wrapped) candidates.push({ text: wrapped, extra: ["fixConcatenated"] });
  candidates.push({ text: tryFixJSON(closedWork), extra: [] });

  let lastErr = "";
  for (const candidate of candidates) {
    try {
      const repaired = runJsonrepair(candidate.text);
      const again = tryParse(repaired);
      if (!again.ok) {
        lastErr = again.error || "";
        continue;
      }
      const used = notes.slice();
      candidate.extra.forEach((key) => addNote(used, key));
      return {
        ok: true,
        text: JSON.stringify(again.value, null, indent),
        repaired: repaired !== original,
        notes: repairNotes(original, repaired, used),
        issues: scan.issues,
      };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }

  const pos = typeof lastErr === "string" ? parsePosition(lastErr, original) : scan.parsed.position;
  return failResult(scan, { error: lastErr || scan.parsed.error, ...lineCol(original, pos) });
}

function repairNotes(before, after, extra) {
  const notes = Array.isArray(extra) ? extra.slice() : [];
  if (before === after) return notes;
  if ((before.match(/'/g) || []).length > (after.match(/'/g) || []).length) addNote(notes, "quotes");
  if (/,\s*[}\]]/.test(before) && !/,\s*[}\]]/.test(after)) addNote(notes, "trailingComma");
  if ((/\/\/|\/\*/.test(before) || /```/.test(before)) && !/\/\/|\/\*/.test(after) && !/```/.test(after)) {
    if (/\/\/|\/\*/.test(before)) addNote(notes, "comments");
  }
  if (/\bNone\b|\bTrue\b|\bFalse\b/.test(before)) addNote(notes, "python");
  if (/\bundefined\b/.test(before) && !/\bundefined\b/.test(after)) addNote(notes, "fixUndefined");
  if ((/\bNaN\b/.test(before) || /\bInfinity\b/.test(before)) && !/\bNaN\b/.test(after) && !/\bInfinity\b/.test(after)) {
    addNote(notes, "fixNan");
  }
  if (/([{,]\s*)[A-Za-z_][\w$]*\s*:/.test(before) && /"\s*:/.test(after)) addNote(notes, "fixUnquoted");
  if (!notes.includes("fixConcatenated")) {
    const beforeClose = (before.match(/[}\]]/g) || []).length;
    const afterClose = (after.match(/[}\]]/g) || []).length;
    if (afterClose > beforeClose) addNote(notes, "fixTruncated");
    if ((after.match(/,/g) || []).length > (before.match(/,/g) || []).length) addNote(notes, "fixMissingComma");
  }
  if (!notes.length) addNote(notes, "generic");
  return notes;
}

function normalizePath(path) {
  const p = String(path || "").trim();
  if (!p) return "$";
  if (p.startsWith("$")) return p;
  if (p.startsWith("[")) return "$" + p;
  return "$." + p;
}

function luhnOk(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return digits.length >= 13 && digits.length <= 19 && sum % 10 === 0;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const BEARER_RE = /^Bearer\s+\S+/i;
const PHONE_RE = /(?:\+?82[-\s]?)?0?1[016789][-\s]?\d{3,4}[-\s]?\d{4}|\+?1?[-\s]?\(?\d{3}\)?[-\s]?\d{3}[-\s]?\d{4}/;
const CARD_RE = /\b(?:\d[ -]*?){13,19}\b/;
const SECRET_KEY = /(api[_-]?key|auth|token|secret|password|passwd|credential)/i;

function maskStringByLength(val) {
  const str = String(val !== undefined && val !== null ? val : "");
  const len = Math.max(1, str.length);
  return "*".repeat(len);
}

function maskString(str, key) {
  const s = String(str);
  if (SECRET_KEY.test(key) && s.length >= 1) return "*".repeat(s.length);
  if (BEARER_RE.test(s)) return "Bearer " + "*".repeat(Math.max(1, s.length - 7));
  if (JWT_RE.test(s)) return "*".repeat(s.length);
  if (EMAIL_RE.test(s)) return s.replace(EMAIL_RE, (m) => "*".repeat(m.length));
  if (PHONE_RE.test(s) && s.replace(/\D/g, "").length >= 10) {
    return s.replace(PHONE_RE, (m) => "*".repeat(m.length));
  }
  const card = s.match(CARD_RE);
  if (card) {
    const digits = card[0].replace(/\D/g, "");
    if (luhnOk(digits)) return s.replace(CARD_RE, (m) => "*".repeat(m.length));
  }
  return s;
}

function collectKeys(value, map = new Map()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, map);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      map.set(k, (map.get(k) || 0) + 1);
      collectKeys(v, map);
    }
  }
  return map;
}

function maskWithSelectedKeys(value, key, keySet) {
  const isTarget = Boolean(key && keySet.has(String(key).toLowerCase()));

  if (isTarget) {
    if (typeof value === "object" && value !== null) {
      if (Array.isArray(value)) {
        return value.map((item) => maskWithSelectedKeys(item, key, keySet));
      }
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = maskWithSelectedKeys(v, k, keySet);
      }
      return out;
    }
    return maskStringByLength(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => maskWithSelectedKeys(item, "", keySet));
  }

  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = maskWithSelectedKeys(v, k, keySet);
    }
    return out;
  }

  return value;
}

function maskValue(value, key, selectedKeys = null) {
  if (selectedKeys && Array.isArray(selectedKeys) && selectedKeys.length > 0) {
    const keySet = new Set(selectedKeys.map((k) => String(k).toLowerCase()));
    return maskWithSelectedKeys(value, key, keySet);
  }
  if (typeof value === "string") return maskString(value, key || "");
  if (Array.isArray(value)) return value.map((item) => maskValue(item, key));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskValue(v, k);
    return out;
  }
  return value;
}

function failResult(scan, extra = {}) {
  const first = scan.issues[0] || scan.parsed;
  return {
    ok: false,
    error: scan.parsed.error || extra.error || "",
    line: first.line,
    column: first.column,
    position: first.position,
    issues: scan.issues,
    ...extra,
  };
}

function handle(msg) {
  const text = String(msg.text || "");
  const indent = msg.minify ? 0 : (Number(msg.indent) === 4 ? 4 : 2);

  if (msg.action === "repair") {
    return repairBrokenJson(text, indent);
  }

  const scan = scanIssues(text);
  let parsed = scan.parsed;

  if (!parsed.ok) {
    if (msg.action === "mask" || msg.action === "get-keys") {
      const sanitized = sanitizeLooseJson(text);
      const trySan = tryParse(sanitized);
      if (trySan.ok) parsed = trySan;
      else return failResult(scan);
    } else {
      return failResult(scan);
    }
  }

  if (msg.action === "get-keys") {
    const keysMap = collectKeys(parsed.value);
    const keysList = Array.from(keysMap.entries()).map(([key, count]) => ({ key, count }));
    return { ok: true, keys: keysList };
  }

  if (msg.action === "query") {
    const path = normalizePath(msg.path);
    try {
      const query = (self.JSONPath && self.JSONPath.JSONPath) || self.JSONPath;
      const found = query({ path, json: parsed.value, wrap: true });
      return { ok: true, text: JSON.stringify(found, null, 2), path };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (msg.action === "mask") {
    const masked = maskValue(parsed.value, "", msg.selectedKeys || null);
    return { ok: true, text: JSON.stringify(masked, null, indent) };
  }

  return { ok: true, text: JSON.stringify(parsed.value, null, indent) };
}

self.onmessage = (event) => {
  const msg = event.data || {};
  try {
    const result = handle(msg);
    self.postMessage({ id: msg.id, ...result });
  } catch (err) {
    self.postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
