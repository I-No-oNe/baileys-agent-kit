import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "dev" && mode !== "start") throw new Error("Usage: node scripts/next-port.mjs <dev|start>");

const configuredPort = process.env.PORT ? Number(process.env.PORT) : 3417;
if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
  throw new Error("PORT must be an integer from 1 to 65535.");
}

function isAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

let port;
for (let candidate = configuredPort; candidate <= Math.min(65_535, configuredPort + 100); candidate += 1) {
  if (await isAvailable(candidate)) {
    port = candidate;
    break;
  }
}
if (!port) throw new Error(`No free port found from ${configuredPort} through ${Math.min(65_535, configuredPort + 100)}.`);
if (port !== configuredPort) console.warn(`Port ${configuredPort} is occupied; using ${port}.`);

const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const child = spawn(process.execPath, [nextBin, mode, "-p", String(port)], {
  stdio: "inherit",
  env: { ...process.env, PORT: String(port) },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
