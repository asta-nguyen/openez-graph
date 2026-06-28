import { serve } from "@hono/node-server";
import { createWebServer } from "./index";
import { API_PORT } from "../lib/constants";

const port = Number(process.env.API_PORT ?? API_PORT);
const app = createWebServer();

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`OpenEZ Graph API server: http://localhost:${info.port}`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Try a different port with API_PORT=<port>`);
  } else {
    console.error(`Server error: ${err.message}`);
  }
  process.exit(1);
});

function shutdown() {
  console.log("\nShutting down...");
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
  // Force exit after 5s if close hangs
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
