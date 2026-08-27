function pad(n, size) {
  const out = new Uint8Array(size);
  out[0] = n & 0xff;
  out[1] = (n >> 8) & 0xff;
  out[2] = (n >> 16) & 0xff;
  out[3] = (n >> 24) & 0xff;
  return out;
}

function strA(text, len) {
  const out = new Uint8Array(len);
  out.fill(0x20);
  const src = new TextEncoder().encode(String(text).toUpperCase().slice(0, len));
  out.set(src);
  return out;
}

function strUcs2(text, lenBytes) {
  const out = new Uint8Array(lenBytes);
  const s = String(text);
  for (let i = 0; i < s.length && i * 2 + 1 < lenBytes; i += 1) {
    const c = s.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = c >> 8;
  }
  return out;
}

function bothEndian(n) {
  const out = new Uint8Array(8);
  out[0] = n & 0xff;
  out[1] = (n >> 8) & 0xff;
  out[2] = (n >> 16) & 0xff;
  out[3] = (n >> 24) & 0xff;
  out[4] = out[3];
  out[5] = out[2];
  out[6] = out[1];
  out[7] = out[0];
  return out;
}

function dateBytes() {
  const d = new Date();
  const s = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}00`;
  const out = new Uint8Array(17);
  out.set(new TextEncoder().encode(s));
  return out;
}

function concat(parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function dirRecord(nameA, nameU, lba, dataLen, isDir) {
  const a = new TextEncoder().encode(nameA);
  const u = strUcs2(nameU, nameU.length * 2);
  const recA = 33 + a.length + ((a.length + 33) % 2);
  const flags = isDir ? 2 : 0;
  function rec(nameBytes, recLen) {
    const r = new Uint8Array(recLen);
    r[0] = recLen;
    r.set(bothEndian(lba), 2);
    r.set(bothEndian(dataLen), 10);
    r[25] = flags;
    r[28] = 1;
    r[31] = 1;
    r[32] = nameBytes.length;
    r.set(nameBytes, 33);
    return r;
  }
  return { iso: rec(a, recA + (recA % 2 === 1 ? 1 : 0)), joliet: rec(u, 33 + u.length + ((33 + u.length) % 2)) };
}

export function makeAutounattendIso(xml) {
  const fileBytes = new TextEncoder().encode(xml);
  const SECTOR = 2048;
  const sysArea = 16;
  let lba = sysArea + 3;
  const pvdLba = sysArea;
  const svdLba = sysArea + 1;
  const termLba = sysArea + 2;
  const ptIsoLba = lba++;
  const ptJolLba = lba++;
  const rootIsoLba = lba++;
  const rootJolLba = lba++;
  const fileLba = lba;
  const fileSectors = Math.ceil(fileBytes.length / SECTOR) || 1;
  lba += fileSectors;
  const total = lba;

  function pvd(type, ident, rootLba, ptLba, joliet) {
    const s = new Uint8Array(SECTOR);
    s[0] = type;
    s.set(new TextEncoder().encode("CD001"), 1);
    s[6] = 1;
    if (joliet) {
      s[8] = 0x25;
      s[9] = 0x2f;
      s[10] = 0x45;
    }
    s.set(joliet ? strUcs2("UNATTEND", 32) : strA("UNATTEND", 32), joliet ? 40 : 40);
    s.set(bothEndian(total), 80);
    s.set(pad(2048, 4), 120);
    s[123] = 8;
    s[124] = 0;
    s[125] = 0;
    s[126] = 8;
    s[127] = 0;
    s.set(bothEndian(ptLba), 132);
    s.set(bothEndian(10), 140);
    const root = new Uint8Array(34);
    root[0] = 34;
    root.set(bothEndian(rootLba), 2);
    root.set(bothEndian(SECTOR), 10);
    root[25] = 2;
    root[28] = 1;
    root[31] = 1;
    root[32] = 1;
    root[33] = 0;
    s.set(root, 156);
    s.set(joliet ? strUcs2("UNATTEND", 128) : strA("UNATTEND", 128), 190);
    s.set(dateBytes(), 813);
    s.set(dateBytes(), 830);
    s.set(dateBytes(), 847);
    s[882] = 1;
    return s;
  }

  const isoName = "AUTOUNAT.XML;1";
  const jolName = "autounattend.xml";
  const rec = dirRecord(isoName, jolName, fileLba, fileBytes.length, false);
  const selfIso = dirRecord("\x00", "\x00", rootIsoLba, SECTOR, true);
  const selfJol = dirRecord("\x00", "\x00", rootJolLba, SECTOR, true);

  const rootIso = new Uint8Array(SECTOR);
  let o = 0;
  rootIso.set(selfIso.iso, o);
  o += selfIso.iso.length;
  rootIso.set(rec.iso, o);

  const rootJol = new Uint8Array(SECTOR);
  o = 0;
  rootJol.set(selfJol.joliet, o);
  o += selfJol.joliet.length;
  rootJol.set(rec.joliet, o);

  const ptIso = new Uint8Array(SECTOR);
  ptIso[0] = 1;
  ptIso.set(bothEndian(rootIsoLba).slice(0, 4), 2);
  ptIso[6] = 1;
  ptIso[7] = 0;
  ptIso[8] = 0;

  const ptJol = new Uint8Array(SECTOR);
  ptJol[0] = 1;
  ptJol.set(bothEndian(rootJolLba).slice(0, 4), 2);
  ptJol[6] = 1;
  ptJol[7] = 0;
  ptJol[8] = 0;

  const term = new Uint8Array(SECTOR);
  term[0] = 255;
  term.set(new TextEncoder().encode("CD001"), 1);
  term[6] = 1;

  const filePad = new Uint8Array(fileSectors * SECTOR);
  filePad.set(fileBytes);

  const zeros = new Uint8Array(sysArea * SECTOR);
  return concat([
    zeros,
    pvd(1, "CD001", rootIsoLba, ptIsoLba, false),
    pvd(2, "CD001", rootJolLba, ptJolLba, true),
    term,
    ptIso,
    ptJol,
    rootIso,
    rootJol,
    filePad,
  ]);
}
