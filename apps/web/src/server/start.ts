import { serve } from "@hono/node-server";
import { createWebServer } from "./index";
import { API_PORT } from "../lib/constants";

const port = Number(process.env.API_PORT ?? API_PORT);
const app = createWebServer();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`OpenEZ Graph API server: http://localhost:${info.port}`);
});
