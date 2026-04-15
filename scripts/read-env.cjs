const fs = require("fs");

const file = process.argv[2] || ".env";
const key = process.argv[3];

if (!key) process.exit(0);
if (!fs.existsSync(file)) process.exit(0);

const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
for (const line of lines) {
  const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)\s*$/);
  if (!match || match[1] !== key) continue;

  let value = match[2].replace(/\s+#.*$/, "").trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  process.stdout.write(value);
  process.exit(0);
}
