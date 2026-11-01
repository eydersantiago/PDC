// Rutas RAG: registerRagRoutes registra, en este orden, las de cursos y fuentes (rag-source-routes.ts) y las de lotes (rag-lot-routes.ts).
import type express from "express";
import type { AppDatabase } from "../../db/database.js";
import { createRagManagerResolver } from "./rag-access.js";
import { registerRagSourceRoutes } from "./rag-source-routes.js";
import { registerRagLotRoutes } from "./rag-lot-routes.js";

export function registerRagRoutes(app: express.Express, database: AppDatabase) {
  const requireRagManager = createRagManagerResolver(database);
  registerRagSourceRoutes(app, database, requireRagManager);
  registerRagLotRoutes(app, database, requireRagManager);
}

