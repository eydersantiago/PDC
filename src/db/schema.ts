// Sentencias del esquema en orden: el valor es la union de las tres partes (schema-core, schema-activity y schema-pilot).
import { coreSchemaStatements } from "./schema-core.js";
import { activitySchemaStatements } from "./schema-activity.js";
import { pilotSchemaStatements } from "./schema-pilot.js";

export const schemaStatements = [
  ...coreSchemaStatements,
  ...activitySchemaStatements,
  ...pilotSchemaStatements,
];
