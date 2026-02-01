import "dotenv/config";
import { env } from "./config/env.js";
import { app } from "./app.js";

app.listen(env.port, "0.0.0.0", () => {
  console.log(`[api] listening on ${env.port}`);
});
