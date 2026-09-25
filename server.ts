import "dotenv/config";
import { createDatabase } from "./src/db/database.js";
import { createApp } from "./src/app.js";
import { env } from "./src/config/env.js";

async function startServer() {
  const database = await createDatabase();
  const app = createApp(database);

  const onListening = () => {
    const mode = ["local", "azure", "queue"].includes(env.targetMode) ? env.targetMode : "invalid";
    console.log(`Agente (${mode}, db=${database.provider}): http://127.0.0.1:${env.port}`);
  };
  // Sin ADACEEN_LISTEN_HOST escucha en todas las interfaces, como siempre (App Service, dev:local).
  // El servicio local de las Mac del laboratorio lo fija en 127.0.0.1 para no exponerse a la red.
  const listenHost = String(process.env.ADACEEN_LISTEN_HOST || "").trim();
  if (listenHost) {
    app.listen(env.port, listenHost, onListening);
  } else {
    app.listen(env.port, onListening);
  }
}

startServer().catch((error) => {
  console.error("[boot] No se pudo iniciar el servidor.", error);
  process.exitCode = 1;
});
