import "dotenv/config";

import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../src/db/database.js";
import { parseBitacoraTemplateUpload } from "../src/services/bitacora-import.js";
import {
  BITACORA_TEMPLATE_DEFAULTS,
  BITACORA_TEMPLATE_FILE_NAME,
  buildBitacoraTemplate,
} from "../src/services/bitacora-template.js";
import { trimText } from "../src/services/text-utils.js";

const TEACHER_USER_ID = "user-teacher-demo";
const TEACHER_EMAIL = "docente@adaceen.edu.co";
const MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function json(value: unknown) {
  return JSON.stringify(value);
}

async function main() {
  const database = await createDatabase();

  try {
    const teacherResult = await database.pool.query<{
      id: string;
      email: string;
      display_name: string;
      role: string;
    }>(
      `
      select
        u.id,
        u.email,
        u.display_name,
        r.code as role
      from users u
      join roles r on r.id = u.role_id
      where u.id = $1
      limit 1
      `,
      [TEACHER_USER_ID],
    );

    const teacher = teacherResult.rows[0];
    if (!teacher || teacher.role !== "teacher") {
      throw new Error(`No se encontro el docente demo ${TEACHER_USER_ID}. Ejecuta la inicializacion de la base primero.`);
    }

    const templateBuffer = await buildBitacoraTemplate({
      teacher: {
        id: teacher.id,
        displayName: teacher.display_name,
        email: teacher.email || TEACHER_EMAIL,
      },
      ...BITACORA_TEMPLATE_DEFAULTS,
    });

    const parsed = await parseBitacoraTemplateUpload(templateBuffer);
    if (!parsed.recognized || !parsed.validation.isValid) {
      throw new Error(`La plantilla generada no paso la validacion: ${parsed.validation.errors.join("; ")}`);
    }

    const outputDir = path.join(repoRoot(), "data", "bitacora-seeds");
    const outputPath = path.join(outputDir, BITACORA_TEMPLATE_FILE_NAME);
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(outputPath, templateBuffer);

    const requestId = "seed-bitacora-fpoo";
    const snapshotId = "seed-bitacora-fpoo-2026-1";
    const filePath = `bitacoras/${BITACORA_TEMPLATE_FILE_NAME}`;
    const repoFullName = `docentes/${teacher.id}`;
    const evidence = [
      `Seed generado desde la plantilla FPOO con ${parsed.bitacoraAgenda.items.length} registro(s).`,
      `Filas semanales usadas: ${parsed.rowsUsed}.`,
    ];
    const reason = `Seed de prueba: ${parsed.bitacoraAgenda.summary}`;
    const features = {
      source: "seed_template",
      bitacoraAgenda: parsed.bitacoraAgenda,
      rowsParsed: parsed.rowsParsed,
      rowsUsed: parsed.rowsUsed,
      detectedTemplate: parsed.detectedTemplate,
      importWarnings: parsed.warnings,
      parsedValidation: parsed.validation,
      generatedTemplatePath: path.relative(repoRoot(), outputPath),
    };
    const trainingExample = {
      input: {
        fileName: BITACORA_TEMPLATE_FILE_NAME,
        filePath,
        textPreview: parsed.textPreview,
      },
      expectedLabel: "BITACORA",
      predictedLabel: "BITACORA",
    };

    const stored = await database.pool.query<{ id: string; updated_at: string | Date }>(
      `
      insert into project_document_classifications (
        id,
        user_id,
        session_id,
        repo_full_name,
        request_id,
        snapshot_id,
        file_path,
        file_name,
        mime_type,
        extension,
        label,
        confidence,
        method,
        evidence,
        reason,
        extracted_text_preview,
        features,
        training_example,
        model_used,
        model_error,
        classified_at,
        updated_at
      )
      values (
        $1,
        $2,
        null,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        'BITACORA',
        0.97,
        'rules',
        $10::jsonb,
        $11,
        $12,
        $13::jsonb,
        $14::jsonb,
        false,
        '',
        now(),
        now()
      )
      on conflict (repo_full_name, snapshot_id, file_path) do update
      set
        user_id = excluded.user_id,
        request_id = excluded.request_id,
        file_name = excluded.file_name,
        mime_type = excluded.mime_type,
        extension = excluded.extension,
        label = excluded.label,
        confidence = excluded.confidence,
        method = excluded.method,
        evidence = excluded.evidence,
        reason = excluded.reason,
        extracted_text_preview = excluded.extracted_text_preview,
        features = excluded.features,
        training_example = excluded.training_example,
        model_used = excluded.model_used,
        model_error = excluded.model_error,
        updated_at = now()
      returning id, updated_at
      `,
      [
        randomUUID(),
        teacher.id,
        repoFullName,
        requestId,
        snapshotId,
        filePath,
        BITACORA_TEMPLATE_FILE_NAME,
        MIME_TYPE,
        "xlsx",
        json(evidence),
        reason,
        trimText(parsed.textPreview).slice(0, 2200),
        json(features),
        json(trainingExample),
      ],
    );

    const previewItems = parsed.bitacoraAgenda.items
      .filter((item) => item.dueAt)
      .slice(0, 5)
      .map((item) => `${item.dueAt?.slice(0, 10)} - ${item.title}`);

    console.log("Seed de bitacora demo listo.");
    console.log(`Docente: ${teacher.display_name} <${teacher.email}> (${teacher.id})`);
    console.log(`Registro: ${stored.rows[0]?.id}`);
    console.log(`Archivo generado: ${outputPath}`);
    console.log(`Items de agenda: ${parsed.bitacoraAgenda.items.length}`);
    console.log(`Resumen: ${parsed.bitacoraAgenda.summary}`);
    console.log("Primeros items:");
    for (const item of previewItems) {
      console.log(`- ${item}`);
    }

    if (database.provider !== "postgres") {
      console.log("");
      console.log("Aviso: DATABASE_URL no esta definido; se uso base en memoria y el seed no persistira al cerrar el proceso.");
    }
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
