function tsType(value, depth) {
  if (value === null) return "null";
  const kind = typeof value;
  if (kind === "string") return "string";
  if (kind === "number") return Number.isInteger(value) ? "number" : "number";
  if (kind === "boolean") return "boolean";
  if (Array.isArray(value)) {
    if (!value.length) return "unknown[]";
    const inner = [...new Set(value.slice(0, 40).map((item) => tsType(item, depth)))];
    if (inner.length === 1) return `${wrapUnion(inner[0])}[]`;
    return `(${inner.join(" | ")})[]`;
  }
  if (kind === "object") return depth > 4 ? "Record<string, unknown>" : "object";
  return "unknown";
}

function wrapUnion(type) {
  return type.includes("|") ? `(${type})` : type;
}

function emitInterface(name, value, bag, depth) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (depth > 5) return;
  const lines = [`export interface ${name} {`];
  for (const [key, child] of Object.entries(value)) {
    const safe = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key);
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const childName = uniqueName(pascal(key) || "Nested", bag);
      emitInterface(childName, child, bag, depth + 1);
      lines.push(`  ${safe}: ${childName};`);
    } else if (Array.isArray(child) && child.some((item) => item && typeof item === "object" && !Array.isArray(item))) {
      const sample = child.find((item) => item && typeof item === "object" && !Array.isArray(item));
      const childName = uniqueName(pascal(key.replace(/s$/, "")) || "Item", bag);
      if (sample) emitInterface(childName, sample, bag, depth + 1);
      lines.push(`  ${safe}: ${childName}[];`);
    } else {
      lines.push(`  ${safe}: ${tsType(child, depth)};`);
    }
  }
  lines.push("}");
  bag.set(name, lines.join("\n"));
}

function pascal(key) {
  return String(key)
    .replace(/[^A-Za-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function uniqueName(base, bag) {
  let name = base || "Root";
  let n = 2;
  while (bag.has(name)) {
    name = `${base}${n}`;
    n += 1;
  }
  bag.set(name, "");
  return name;
}

export function toTypeScript(value) {
  if (Array.isArray(value)) {
    if (!value.length) throw new Error("empty-array");
    const sample = value.find((item) => item && typeof item === "object" && !Array.isArray(item));
    if (!sample) {
      return `export type Root = ${tsType(value, 0)};\n`;
    }
    const bag = new Map();
    const root = uniqueName("Item", bag);
    emitInterface(root, sample, bag, 0);
    return `${[...bag.values()].filter(Boolean).join("\n\n")}\n\nexport type Root = ${root}[];\n`;
  }
  if (!value || typeof value !== "object") throw new Error("not-object");
  const bag = new Map();
  const root = uniqueName("Root", bag);
  emitInterface(root, value, bag, 0);
  return `${[...bag.values()].filter(Boolean).join("\n\n")}\n`;
}

function pyLiteral(value, indent) {
  const pad = "  ".repeat(indent);
  const next = "  ".repeat(indent + 1);
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "None";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const parts = value.map((item) => `${next}${pyLiteral(item, indent + 1)}`);
    return `[\n${parts.join(",\n")}\n${pad}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) return "{}";
    const parts = keys.map((key) => `${next}${JSON.stringify(key)}: ${pyLiteral(value[key], indent + 1)}`);
    return `{\n${parts.join(",\n")}\n${pad}}`;
  }
  return "None";
}

export function toPython(value) {
  return `data = ${pyLiteral(value, 0)}\n`;
}
