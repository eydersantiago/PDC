// Rutas del proyecto: registerProjectContextRoutes registra, en este orden, las del contexto del proyecto y las de acciones de codigo.
import express from "express";
import type { AppDatabase } from "../db/database.js";
import { registerProjectCodeActionRoutes } from "./project-code-action-routes.js";
import { registerProjectContextStateRoutes } from "./project-context-state-routes.js";

export function registerProjectContextRoutes(app: express.Express, database: AppDatabase) {
  registerProjectContextStateRoutes(app, database);
  registerProjectCodeActionRoutes(app, database);
}
