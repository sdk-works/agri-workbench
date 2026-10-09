import fs from "node:fs";
export function loadEnv() {
  const values = {};
  const file = new URL("./.env", import.meta.url);
  if (fs.existsSync(file))
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) values[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  return { ...values, ...process.env };
}
