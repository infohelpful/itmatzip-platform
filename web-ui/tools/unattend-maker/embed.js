export function toBase64Bytes(bytes) {
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}

export function toBase64Utf8(text) {
  return toBase64Bytes(new TextEncoder().encode(String(text)));
}

export function toBase64Utf16Le(text) {
  const s = String(text);
  const bytes = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = code >> 8;
  }
  return toBase64Bytes(bytes);
}

export function obscurePassword(password, elementName) {
  return toBase64Utf16Le(`${password || ""}${elementName}`);
}

export function writeDecodedFileCommands(b64, destCmd) {
  const cmds = [];
  const b64Path = destCmd.replace(/[^A-Za-z0-9._\\:-]/g, "") + ".b64";
  const tmp = b64Path.includes(":") ? b64Path : `X:\\${b64Path}`;
  for (let i = 0, n = 0; i < b64.length; i += 72, n += 1) {
    const chunk = b64.slice(i, i + 72);
    const redir = n === 0 ? ">" : ">>";
    cmds.push(`cmd.exe /c "<nul set /p=${chunk}${redir}${tmp}"`);
  }
  cmds.push(`certutil.exe -decode -f ${tmp} ${destCmd}`);
  return cmds;
}

export function dropAndRunPe(text, dest = "X:\\itmz-pe.cmd") {
  const cmds = writeDecodedFileCommands(toBase64Utf8(text.replace(/\n/g, "\r\n")), dest);
  cmds.push(dest);
  return cmds;
}

export function embedSetupFile(filename, content) {
  const dest = `C:\\Windows\\Setup\\Scripts\\${filename}`;
  const b64 = toBase64Utf8(content);
  const tmp = `C:\\Windows\\Setup\\Scripts\\${filename}.b64`;
  const cmds = [`cmd.exe /c "mkdir C:\\Windows\\Setup\\Scripts 2>nul"`];
  for (let i = 0, n = 0; i < b64.length; i += 72, n += 1) {
    const chunk = b64.slice(i, i + 72);
    const redir = n === 0 ? ">" : ">>";
    cmds.push(`cmd.exe /c "<nul set /p=${chunk}${redir}${tmp}"`);
  }
  cmds.push(`certutil.exe -decode -f ${tmp} ${dest}`);
  cmds.push(`cmd.exe /c "del /f /q ${tmp}"`);
  return { dest, cmds };
}

export function psInvoke(path, hidden) {
  const style = hidden ? "Hidden" : "Normal";
  return `powershell.exe -WindowStyle ${style} -NoProfile -ExecutionPolicy Unrestricted -File "${path}"`;
}

export function runByType(path, type, hidden) {
  switch (type) {
    case "ps1":
      return psInvoke(path, hidden);
    case "reg":
      return `reg.exe import "${path}"`;
    case "vbs":
      return `cscript.exe //E:vbscript "${path}"`;
    case "js":
      return `cscript.exe //E:jscript "${path}"`;
    default:
      return path;
  }
}

export function xmlEsc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
