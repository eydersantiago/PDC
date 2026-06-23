import { trimText } from "./text-utils.js";

export type RagCourseConfig = {
  code: string;
  name: string;
  shortName: string;
  materialUrl: string;
  driveFileId: string;
  isDefault: boolean;
};

export const DEFAULT_RAG_COURSE_CODE = "FPOO";

export const RAG_COURSES = [
  {
    code: "FPI",
    name: "Fundamentos de programación Imperativa",
    shortName: "Imperativa",
    materialUrl: "https://drive.google.com/file/d/1eInPt6FjpgOIAGGp-k-AiXrNcTNoGV3N/view?usp=sharing",
    driveFileId: "1eInPt6FjpgOIAGGp-k-AiXrNcTNoGV3N",
    isDefault: false,
  },
  {
    code: "FPOO",
    name: "Fundamentos de programación orientada a objetos",
    shortName: "FPOO",
    materialUrl: "https://drive.google.com/file/d/1eInPt6FjpgOIAGGp-k-AiXrNcTNoGV3N/view?usp=sharing",
    driveFileId: "1eInPt6FjpgOIAGGp-k-AiXrNcTNoGV3N",
    isDefault: true,
  },
  {
    code: "FPOE",
    name: "Fundamentos de programación orientada a eventos",
    shortName: "Eventos",
    materialUrl: "https://drive.google.com/file/d/1uoIyX8w6YzpK0BuBuX_E6ZyrUY4vknDh/view?usp=sharing",
    driveFileId: "1uoIyX8w6YzpK0BuBuX_E6ZyrUY4vknDh",
    isDefault: false,
  },
  {
    code: "FPFC",
    name: "Fundamentos de programación funcional y concurrente",
    shortName: "Funcional y concurrente",
    materialUrl: "https://drive.google.com/file/d/1G3yaR_M6HBMMD59kbCC029dJzSCREZzK/view?usp=sharing",
    driveFileId: "1G3yaR_M6HBMMD59kbCC029dJzSCREZzK",
    isDefault: false,
  },
] satisfies RagCourseConfig[];

export function normalizeRagCourseCode(value: string | null | undefined) {
  const clean = trimText(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
  if (!clean) return DEFAULT_RAG_COURSE_CODE;
  if (clean === "FPI" || clean.includes("IMPERATIVA")) return "FPI";
  if (clean === "FPOO" || clean === "POO" || clean.includes("OBJETOS")) return "FPOO";
  if (clean === "FPOE" || clean.includes("EVENTOS")) return "FPOE";
  if (clean === "FPFC" || clean.includes("FUNCIONAL") || clean.includes("CONCURRENTE")) return "FPFC";
  return clean;
}

export function getRagCourse(code: string | null | undefined) {
  const normalized = normalizeRagCourseCode(code);
  return RAG_COURSES.find((course) => course.code === normalized) || null;
}

export function getDefaultRagCourse() {
  return RAG_COURSES.find((course) => course.isDefault) || RAG_COURSES[0];
}

export function getKnownRagCourseOrDefault(code: string | null | undefined) {
  return getRagCourse(code) || getDefaultRagCourse();
}

export function normalizeRagCourseCodes(
  values: unknown,
  options?: {
    fallbackToDefault?: boolean;
    knownOnly?: boolean;
  },
) {
  const fallbackToDefault = options?.fallbackToDefault !== false;
  const knownOnly = options?.knownOnly !== false;
  const rawValues = Array.isArray(values)
    ? values.map((item) => trimText(String(item ?? ""))).filter(Boolean)
    : trimText(String(values ?? ""))
      .split(",")
      .map((item) => trimText(item))
      .filter(Boolean);
  const normalized = rawValues
    .map((item) => normalizeRagCourseCode(String(item ?? "")))
    .filter((code) => Boolean(code))
    .filter((code) => !knownOnly || Boolean(getRagCourse(code)));
  const unique = [...new Set(normalized)];
  if (unique.length > 0) return unique;
  return fallbackToDefault ? [DEFAULT_RAG_COURSE_CODE] : [];
}

export function inferRagCourseCodeFromText(value: string) {
  const text = trimText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (/\bfpoe\b|orientada a eventos|eventos/.test(text)) return "FPOE";
  if (/\bfpfc\b|funcional|concurrente/.test(text)) return "FPFC";
  if (/\bfpi\b|imperativa/.test(text)) return "FPI";
  if (/\bfpoo\b|poo|orientada a objetos|objetos|c\+\+/.test(text)) return "FPOO";
  return DEFAULT_RAG_COURSE_CODE;
}

export function ragCourseMetadata(code: string | null | undefined) {
  const course = getKnownRagCourseOrDefault(code);
  return {
    courseCode: course.code,
    courseName: course.name,
    courseShortName: course.shortName,
    courseMaterialUrl: course.materialUrl,
    courseDriveFileId: course.driveFileId,
    defaultCourse: course.isDefault,
  };
}
