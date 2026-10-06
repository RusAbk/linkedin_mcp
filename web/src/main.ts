import path from "node:path";
import { fileURLToPath } from "node:url";
import { UserStore } from "./users.js";
import { RuntimePool } from "./runtime.js";
import { createWebServer } from "./server.js";

process.umask(0o077);
const publicDir = fileURLToPath(new URL("../public", import.meta.url));
const webRoot = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../" : "../../../", import.meta.url));
const dataRoot = path.resolve(process.env.WEB_DATA_DIR ?? path.join(webRoot, ".data"));
const users = new UserStore(path.join(dataRoot, "users.sqlite"));
if (!users.list().length) {
  const adminPassword = process.env.WEB_ADMIN_PASSWORD ?? "";
  if (adminPassword.startsWith("replace-with-")) throw new Error("Замените WEB_ADMIN_PASSWORD на уникальный случайный пароль.");
  users.create(process.env.WEB_ADMIN_USER ?? "admin", adminPassword, "admin");
}
const maxBrowsers = Number(process.env.WEB_MAX_BROWSERS ?? 8);
if (!Number.isInteger(maxBrowsers) || maxBrowsers < 1) throw new Error("Некорректный WEB_MAX_BROWSERS.");
const runtimes = new RuntimePool(dataRoot, webRoot, maxBrowsers);
const port = Number(process.env.WEB_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Некорректный WEB_PORT.");
const app = createWebServer({ publicUrl: process.env.WEB_PUBLIC_URL ?? `http://localhost:${port}`, publicDir, users, runtimes });
app.server.listen(port, process.env.WEB_HOST ?? "127.0.0.1", () => console.log(`LinkedIn MCP Portal listening on port ${port}`));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  app.server.close();
  await app.drain();
  await runtimes.close();
  app.server.closeAllConnections();
  users.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
