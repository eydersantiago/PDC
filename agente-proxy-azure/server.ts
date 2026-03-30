import "dotenv/config";
import { createDatabase } from "./src/db/database.js";
import { createApp } from "./src/app.js";
import { env } from "./src/config/env.js";

async function startServer() {
  const database = await createDatabase();
  const app = createApp(database);

  app.listen(env.port, () => {
    const mode = env.targetMode === "azure" ? "azure" : "local";
    console.log(`Agente (${mode}, db=${database.provider}): http://127.0.0.1:${env.port}`);
  });
}

startServer().catch((error) => {
  console.error("[boot] No se pudo iniciar el servidor.", error);
  process.exitCode = 1;
});
