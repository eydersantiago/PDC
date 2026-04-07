import { randomBytes, scryptSync } from "node:crypto";
import type { PolicyEventType, TeacherPolicy } from "../types/app.js";

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

export const seedUsers = [
  {
    id: "user-admin-demo",
    roleId: "role-admin",
    teacherUserId: null,
    email: "admin@adaceen.edu.co",
    displayName: "Administrador Demo",
    passwordHash: hashPassword("Admin123!"),
  },
  {
    id: "user-teacher-demo",
    roleId: "role-teacher",
    teacherUserId: null,
    email: "docente@adaceen.edu.co",
    displayName: "Docente Demo",
    passwordHash: hashPassword("Docente123!"),
  },
  {
    id: "user-student-demo",
    roleId: "role-student",
    teacherUserId: "user-teacher-demo",
    email: "estudiante@adaceen.edu.co",
    displayName: "Estudiante Demo",
    passwordHash: hashPassword("Estudiante123!"),
  },
];

const defaultEventRules: TeacherPolicy["eventRules"] = {
  compile_error: {
    enabled: true,
    interventionType: "hint",
    detailLevel: "guided",
    activationThreshold: 1,
    maxUsesPerSession: 4,
  },
  runtime_error: {
    enabled: true,
    interventionType: "hint",
    detailLevel: "guided",
    activationThreshold: 1,
    maxUsesPerSession: 4,
  },
  concept_question: {
    enabled: true,
    interventionType: "explanation",
    detailLevel: "brief",
    activationThreshold: 1,
    maxUsesPerSession: 5,
  },
  design_block: {
    enabled: true,
    interventionType: "hint",
    detailLevel: "progressive",
    activationThreshold: 1,
    maxUsesPerSession: 4,
  },
  workflow_guidance: {
    enabled: true,
    interventionType: "hint",
    detailLevel: "brief",
    activationThreshold: 1,
    maxUsesPerSession: 3,
  },
  insufficient_context: {
    enabled: true,
    interventionType: "controlled_message",
    detailLevel: "brief",
    activationThreshold: 1,
    maxUsesPerSession: null,
  },
  out_of_domain: {
    enabled: true,
    interventionType: "controlled_message",
    detailLevel: "brief",
    activationThreshold: 1,
    maxUsesPerSession: null,
  },
};

export const seedTeacherPolicy = {
  id: "policy-teacher-demo",
  teacherUserId: "user-teacher-demo",
  policyName: "RF-05 base del piloto",
  outcome: "RA1",
  tone: "warm",
  frequency: "medium",
  helpLevel: "progressive",
  allowMiniQuiz: true,
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

export const supportedPolicyEvents: PolicyEventType[] = [
  "compile_error",
  "runtime_error",
  "concept_question",
  "design_block",
  "workflow_guidance",
  "insufficient_context",
  "out_of_domain",
];
