const fs = require("node:fs");
const { spawn } = require("node:child_process");
const dotenv = require("dotenv");

dotenv.config();

const extraCaCertPath = (process.env.EXTRA_CA_CERT_PATH || "").trim();
const childEnv = { ...process.env };

if (extraCaCertPath) {
  if (fs.existsSync(extraCaCertPath)) {
    childEnv.NODE_EXTRA_CA_CERTS = extraCaCertPath;
    console.log(`Using extra CA certificate: ${extraCaCertPath}`);
  } else {
    console.warn(`EXTRA_CA_CERT_PATH is set, but the file does not exist: ${extraCaCertPath}`);
    console.warn("Starting without an extra CA certificate.");
  }
}

const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npx";
const args = process.platform === "win32" ? ["/d", "/s", "/c", "npx tsx src/index.ts"] : ["tsx", "src/index.ts"];
const child = spawn(command, args, {
  env: childEnv,
  stdio: "inherit"
});

child.on("error", (error) => {
  console.error("Failed to start dev process:", error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
