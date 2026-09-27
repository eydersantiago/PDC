import type { RagSource } from "../types/app.js";
import { DEFAULT_RAG_COURSE_CODE, normalizeRagCourseCode } from "./rag-courses.js";
import { trimText } from "./text-utils.js";

/**
 * Lotes de RAG por curso (navegador 0.7.15).
 *
 * Cada curso tiene la "base": las fuentes default del curso (las que vienen
 * del programa) mas las que el docente cargo sin lote. El docente puede
 * desactivar cualquiera de esas fuentes para si (rag_source_overrides) y crear
 * lotes con otro enfoque: un lote usa sus propias fuentes y, si includesBase,
 * tambien la base. Por curso y docente hay un solo lote activo (null = base);
 * a un estudiante se le puede asignar otro lote (rag_student_lots).
 *
 * La resolucion del lote efectivo y el filtrado de fuentes son funciones puras
 * de este modulo; las consultas estan en db/database.ts.
 */

export const BASE_LOT_ID = "";
export const BASE_LOT_NAME = "Base del curso";

export type RagLot = {
  id: string;
  teacherUserId: string;
  courseCode: string;
  name: string;
  description: string;
  includesBase: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RagSourceOverride = {
  sourceId: string;
  isActive: boolean;
};

export type RagStudentLot = {
  studentUserId: string;
  courseCode: string;
  lotId: string;
};

export type EffectiveRagLot = {
  /** "" = base del curso. */
  lotId: string;
  name: string;
  includesBase: boolean;
  /** De donde salio: asignacion del estudiante, lote activo del docente o la base. */
  origin: "student" | "teacher" | "base";
};

export function ragSourceLotId(source: Pick<RagSource, "metadata">) {
  const metadata = source.metadata && typeof source.metadata === "object" ? source.metadata : {};
  return trimText(String((metadata as Record<string, unknown>).lotId ?? (metadata as Record<string, unknown>).lot_id ?? ""));
}

export function ragSourceCourseCode(source: Pick<RagSource, "metadata">) {
  const metadata = source.metadata && typeof source.metadata === "object" ? (source.metadata as Record<string, unknown>) : {};
  return normalizeRagCourseCode(String(metadata.courseCode || metadata.course_code || DEFAULT_RAG_COURSE_CODE));
}

/** Nombre y descripcion validos para un lote. */
export function normalizeRagLotInput(input: { name?: unknown; description?: unknown; includesBase?: unknown }) {
  const name = trimText(String(input.name ?? "")).slice(0, 80);
  const description = trimText(String(input.description ?? "")).slice(0, 400);
  const includesBase = input.includesBase === undefined ? true : input.includesBase === true || input.includesBase === "true";
  if (name.length < 2) {
    throw new Error("El lote necesita un nombre de al menos 2 caracteres.");
  }
  return { name, description, includesBase };
}

/**
 * Lote efectivo para un estudiante (o docente) en un curso: la asignacion del
 * estudiante si existe y sigue activa; si no, el lote activo del docente en ese
 * curso; si no, la base.
 */
export function resolveEffectiveLot(input: {
  courseCode: string;
  lots: RagLot[];
  activeLotId: string | null | undefined;
  studentLotId?: string | null;
}): EffectiveRagLot {
  const courseCode = normalizeRagCourseCode(input.courseCode || DEFAULT_RAG_COURSE_CODE);
  const usable = (lotId: string | null | undefined) => {
    const id = trimText(lotId || "");
    if (!id) return null;
    const lot = input.lots.find((item) => item.id === id && item.isActive && normalizeRagCourseCode(item.courseCode) === courseCode);
    return lot || null;
  };
  const studentLot = usable(input.studentLotId);
  if (studentLot) {
    return { lotId: studentLot.id, name: studentLot.name, includesBase: studentLot.includesBase, origin: "student" };
  }
  const teacherLot = usable(input.activeLotId);
  if (teacherLot) {
    return { lotId: teacherLot.id, name: teacherLot.name, includesBase: teacherLot.includesBase, origin: "teacher" };
  }
  return { lotId: BASE_LOT_ID, name: BASE_LOT_NAME, includesBase: true, origin: "base" };
}

/**
 * Fuentes que entran en un lote efectivo: las del lote (metadata.lotId) y, si el
 * lote incluye la base, las default y las del docente sin lote. Las que el
 * docente desactivo (overrides) no entran nunca.
 */
export function filterSourcesForLot(
  sources: RagSource[],
  lot: EffectiveRagLot,
  overrides: RagSourceOverride[] = [],
) {
  const disabled = new Set(overrides.filter((item) => item.isActive === false).map((item) => item.sourceId));
  return sources.filter((source) => {
    if (disabled.has(source.id)) return false;
    const sourceLotId = ragSourceLotId(source);
    if (lot.lotId) {
      if (sourceLotId === lot.lotId) return true;
      return lot.includesBase && !sourceLotId;
    }
    return !sourceLotId;
  });
}

/** Resumen por curso para el panel del docente. */
export function summarizeLotsForCourse(input: {
  courseCode: string;
  lots: RagLot[];
  sources: RagSource[];
  overrides: RagSourceOverride[];
  activeLotId: string | null;
}) {
  const courseCode = normalizeRagCourseCode(input.courseCode);
  const disabled = new Set(input.overrides.filter((item) => item.isActive === false).map((item) => item.sourceId));
  const courseSources = input.sources.filter((source) => ragSourceCourseCode(source) === courseCode);
  const baseSources = courseSources.filter((source) => !ragSourceLotId(source));
  const lots = input.lots
    .filter((lot) => normalizeRagCourseCode(lot.courseCode) === courseCode && lot.isActive)
    .map((lot) => {
      const own = courseSources.filter((source) => ragSourceLotId(source) === lot.id);
      return {
        ...lot,
        sourceCount: own.length,
        activeSourceCount: own.filter((source) => !disabled.has(source.id)).length,
        isCourseActive: trimText(input.activeLotId || "") === lot.id,
      };
    });
  const activeLotId = trimText(input.activeLotId || "");
  const activeLot = lots.find((lot) => lot.id === activeLotId) || null;
  return {
    courseCode,
    activeLotId: activeLot ? activeLot.id : BASE_LOT_ID,
    activeLotName: activeLot ? activeLot.name : BASE_LOT_NAME,
    base: {
      sourceCount: baseSources.length,
      activeSourceCount: baseSources.filter((source) => !disabled.has(source.id)).length,
      defaultCount: baseSources.filter((source) => source.scope === "default").length,
      teacherCount: baseSources.filter((source) => source.scope === "teacher").length,
    },
    lots,
  };
}
