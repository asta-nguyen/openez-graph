import { serve } from "@hono/node-server";
import { createWebServer } from "./index";

const port = Number(process.env.API_PORT ?? 11368);
const app = createWebServer();

serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`OpenEZ Graph API server: http://${info.address}:${info.port}`);
});
