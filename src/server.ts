import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { env } from "./env";

const app = createApp();
serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`lawkku-freshstart23 api listening on :${info.port}`);
});
