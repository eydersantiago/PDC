// Rutas del escaneo del proyecto: registerProjectScanRoutes registra, en este orden, las de pedidos y estado y las del resultado del worker.
import type express from "express";
import type { AppDatabase } from "../../db/database.js";
import { registerProjectScanRequestRoutes } from "./project-scan-request-routes.js";
import { registerProjectScanWorkerResultRoutes } from "./project-scan-worker-routes.js";

export function registerProjectScanRoutes(app: express.Express, database: AppDatabase) {
  registerProjectScanRequestRoutes(app, database);
  registerProjectScanWorkerResultRoutes(app, database);
}

