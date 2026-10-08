import { randomBytes, scryptSync } from "node:crypto";
import type { PolicyEventType, TeacherPolicy } from "../types/app.js";
import { DEFAULT_QUIZ_SETTINGS } from "../services/quiz-settings.js";
import { DEFAULT_CODE_APPLICATION_SETTINGS, DEFAULT_EVENT_RULES, POLICY_EVENT_TYPES } from "../services/policy-settings.js";
import { DEMO_ACCOUNTS } from "../services/demo-accounts.js";

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export const seedRoles = [
  { id: "role-student", code: "student", name: "Estudiante" },
  { id: "role-teacher", code: "teacher", name: "Profesor" },
  { id: "role-admin", code: "admin", name: "Administrador" },
];

// Cuentas demo (correos y claves publicadas en src/services/demo-accounts.ts). Solo se siembran
// con SEED_DEMO_ACCOUNTS=true (el valor por defecto; en produccion va en false).
const demoTeacherId = DEMO_ACCOUNTS.find((account) => account.role === "teacher")?.id ?? null;

export const seedUsers = DEMO_ACCOUNTS.map((account) => ({
  id: account.id,
  roleId: `role-${account.role}`,
  teacherUserId: account.role === "student" ? demoTeacherId : null,
  email: account.email,
  displayName: account.displayName,
  passwordHash: hashPassword(account.password),
}));

const defaultEventRules: TeacherPolicy["eventRules"] = DEFAULT_EVENT_RULES;

export const seedTeacherPolicy = {
  id: "policy-teacher-demo",
  teacherUserId: "user-teacher-demo",
  policyName: "RF-05 base del piloto",
  outcome: "RA1",
  tone: "warm",
  frequency: "medium",
  helpLevel: "progressive",
  allowMiniQuiz: true,
  quizSettings: DEFAULT_QUIZ_SETTINGS,
  codeApplication: DEFAULT_CODE_APPLICATION_SETTINGS,
  strictNoSolution: true,
  maxHintsPerExercise: 3,
  fallbackMessage:
    "No puedo ayudar con ese tema o con tan poco contexto. Muestrame el ejercicio, el error o un fragmento del codigo del curso.",
  customInstruction:
    "Prioriza pistas graduales, preguntas orientadoras y trazabilidad para el piloto.",
  allowedInterventions: ["explanation", "hint", "example", "mini_quiz"],
  allowedTopics: [
    "RA1",
    "RA2",
    "RA3",
    "IL1",
    "IL2",
    "IL3",
    "IL4",
    "IL5",
    "IL6",
    "IL7",
    "IL8",
    "clases",
    "objetos",
    "encapsulamiento",
    "herencia",
    "polimorfismo",
    "C++",
    "Python",
    "GitHub",
    "Codespaces",
  ],
  eventRules: defaultEventRules,
} satisfies Omit<TeacherPolicy, "updatedAt">;

export const supportedPolicyEvents: PolicyEventType[] = [...POLICY_EVENT_TYPES];
