import "dotenv/config";
import { createDatabase } from "./src/db/database.js";
import { createApp } from "./src/app.js";
import { env } from "./src/config/env.js";
import { startResultProcessor } from "./src/jobs/result-processor.js";
import { closeServiceBusClient } from "./src/queue/service-bus.js";

async function startServer() {
  const database = await createDatabase();
  const app = createApp(database);
  const resultProcessor = env.targetMode === "queue"
    ? await startResultProcessor(database)
    : { close: async () => {} };

  const server = app.listen(env.port, () => {
    console.log(`Agente (${env.targetMode}, db=${database.provider}): http://127.0.0.1:${env.port}`);
  });

  async function shutdown(signal: string) {
    console.log(`[boot] Recibido ${signal}, cerrando servidor.`);
    server.close(async () => {
      await resultProcessor.close().catch(() => {});
      await closeServiceBusClient().catch(() => {});
      await database.close().catch(() => {});
      process.exit(0);
    });
  }

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

startServer().catch((error) => {
  console.error("[boot] No se pudo iniciar el servidor.", error);
  process.exitCode = 1;
});
