// Rutas de documentos: registerDocumentRoutes registra, en este orden, datos, plantilla e importacion de la bitacora y clasificacion de documentos.
import express from "express";
import type { AppDatabase } from "../db/database.js";
import { registerBitacoraDataRoutes } from "./bitacora-data-routes.js";
import { registerBitacoraImportRoutes } from "./bitacora-import-routes.js";
import { registerBitacoraTemplateRoutes } from "./bitacora-template-routes.js";
import { registerDocumentClassificationRoutes } from "./document-classification-routes.js";

export function registerDocumentRoutes(app: express.Express, database: AppDatabase) {
  registerBitacoraDataRoutes(app, database);
  registerBitacoraTemplateRoutes(app, database);
  registerBitacoraImportRoutes(app, database);
  registerDocumentClassificationRoutes(app, database);
}
