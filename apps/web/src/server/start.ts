import { serve } from "@hono/node-server";
import { createWebServer } from "./index";

const port = Number(process.env.API_PORT ?? 11368);
const app = createWebServer();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`OpenEZ Graph API server: http://localhost:${info.port}`);
});
