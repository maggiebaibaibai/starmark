import { existsSync } from "node:fs";
import { createApp } from "./app.js";
// Node 20.12+ supports loadEnvFile. Earlier Node 20 runs with shell environment.
if (existsSync(".env") && "loadEnvFile" in process) process.loadEnvFile(".env");
if (process.env.STARMARK_MOCK === "0")
  throw new Error("Real Twitch is Task 2. Set STARMARK_MOCK=1 for this build.");
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("PORT must be 0–65535");
const server = await createApp({
  channel: process.env.TWITCH_CHANNEL || "yourchannel",
  publicUrl: process.env.PUBLIC_URL,
});
console.log(`Starmark MOCK → ${await server.listen(port)}/dashboard`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
