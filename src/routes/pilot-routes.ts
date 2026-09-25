import type express from "express";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import {
  assignPilotCohorts,
  describePilotBlock,
  normalizePilotBlock,
  type PilotBlock,
} from "../services/pilot.js";
import { errorMessage, resolveSession, type AppSession } from "./route-utils.js";

/**
 * Piloto con y sin tutor (A13.1, diseno AB/BA).
 *
 * El docente de cada grupo (o un administrador en su nombre) asigna las
 * cohortes A y B y cambia de bloque. El bloque vigente decide, estudiante por
 * estudiante, si el tutor responde (ver src/services/pilot.ts). Cada cambio
 * queda en pilot_block_log para reconstruir las ventanas en el analisis.
 */

const assignSchema = z.object({
  reset: z.boolean().optional(),
  seed: z.string().trim().max(120).optional(),
  teacherUserId: z.string().trim().max(80).optional(),
}).strict();

/** Menos estudiantes activos que esto: iniciar un bloque no asigna los grupos solo. */
const MIN_STUDENTS_FOR_AUTO_ASSIGN = 2;

const blockSchema = z.object({
  block: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  teacherUserId: z.string().trim().max(80).optional(),
}).strict();

export function registerPilotRoutes(app: express.Express, database: AppDatabase) {
  /** Docente (su grupo) o administrador (el grupo que indique). */
  async function requireOperator(req: express.Request, res: express.Response): Promise<{ session: AppSession; teacherUserId: string } | null> {
    const session = await resolveSession(database, req).catch(() => null);
    if (!session) {
      res.status(401).json({ ok: false, error: "Sesion requerida." });
      return null;
    }
    const requested = String(req.body?.teacherUserId || req.query.teacherUserId || "").trim();
    if (session.user.role === "teacher") {
      if (requested && requested !== session.user.id) {
        res.status(403).json({ ok: false, error: "Un docente solo maneja el piloto de su grupo." });
        return null;
      }
      return { session, teacherUserId: session.user.id };
    }
    if (session.user.role === "admin") {
      if (!requested) {
        res.status(400).json({ ok: false, error: "Indica teacherUserId: el piloto va por docente." });
        return null;
      }
      return { session, teacherUserId: requested };
    }
    res.status(403).json({ ok: false, error: "Solo el docente o un administrador manejan el piloto." });
    return null;
  }

  /**
   * Asigna las cohortes que faltan (o todas, con reset) y las guarda con su
   * semilla. La usan «Asignar grupos A y B» y el primer bloque sin grupos:
   * quien ya tiene grupo no cambia de cohorte.
   */
  async function assignCohorts(teacherUserId: string, options: { seed?: string; reset: boolean }) {
    const students = await database.listActiveStudents(teacherUserId);
    const existing = await database.listPilotAssignments(teacherUserId);
    const seed = options.seed || `${teacherUserId}:${new Date().toISOString().slice(0, 10)}`;
    const result = assignPilotCohorts({
      studentUserIds: students.map((student) => student.id),
      existing,
      seed,
      reset: options.reset,
    });
    await database.savePilotAssignments(
      teacherUserId,
      options.reset ? result.assignments : result.added,
      { reset: options.reset, seed },
    );
    return result;
  }

  async function pilotSummary(teacherUserId: string) {
    const [state, students, assignments] = await Promise.all([
      database.getPilotBlock(teacherUserId),
      database.listActiveStudents(teacherUserId),
      database.listPilotAssignments(teacherUserId),
    ]);
    const cohortById = new Map(assignments.map((item) => [item.studentUserId, item.cohort]));
    const counts = { A: 0, B: 0, sinAsignar: 0 };
    const list = students.map((student) => {
      const cohort = cohortById.get(student.id) || "";
      if (cohort === "A" || cohort === "B") counts[cohort] += 1;
      else counts.sinAsignar += 1;
      return { id: student.id, displayName: student.displayName, cohort };
    });
    return {
      ok: true,
      teacherUserId,
      block: state.block,
      description: describePilotBlock(state.block),
      seed: state.seed,
      updatedAt: state.updatedAt,
      counts,
      students: list,
    };
  }

  app.get("/api/pilot", async (req, res) => {
    try {
      const operator = await requireOperator(req, res);
      if (!operator) return;
      return res.json(await pilotSummary(operator.teacherUserId));
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.post("/api/pilot/assign", async (req, res) => {
    try {
      const operator = await requireOperator(req, res);
      if (!operator) return;
      const input = assignSchema.parse(req.body || {});
      const state = await database.getPilotBlock(operator.teacherUserId);
      if (input.reset && state.block !== 0) {
        return res.status(409).json({
          ok: false,
          error: "El piloto esta en curso: termina el bloque (bloque 0) antes de reasignar los grupos.",
        });
      }
      const result = await assignCohorts(operator.teacherUserId, {
        seed: input.seed || state.seed,
        reset: input.reset === true,
      });
      return res.json({ ...(await pilotSummary(operator.teacherUserId)), added: result.added.length });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  app.put("/api/pilot/block", async (req, res) => {
    try {
      const operator = await requireOperator(req, res);
      if (!operator) return;
      const input = blockSchema.parse(req.body || {});
      const block = normalizePilotBlock(input.block) as PilotBlock;
      // Sin grupos, iniciar un bloque los asigna como «Asignar grupos A y B»
      // (al azar y en partes iguales) en vez de pedir ese paso aparte. Con
      // menos de 2 estudiantes activos no: un grupo quedaria vacio (y con uno
      // solo, ese estudiante podria quedar sin tutor sin que nadie lo eligiera).
      let autoAssigned = 0;
      if (block !== 0) {
        const assignments = await database.listPilotAssignments(operator.teacherUserId);
        if (!assignments.length) {
          const students = await database.listActiveStudents(operator.teacherUserId);
          if (!students.length) {
            return res.status(409).json({
              ok: false,
              error: "No hay estudiantes activos en tu grupo para asignar a los grupos A y B.",
            });
          }
          if (students.length < MIN_STUDENTS_FOR_AUTO_ASSIGN) {
            return res.status(409).json({
              ok: false,
              error: "Solo hay 1 estudiante activo en tu grupo: los grupos A y B se asignan solos desde 2. "
                + "Si quieres asignarlo igual, pulsa «Asignar grupos A y B» y vuelve a iniciar el bloque.",
            });
          }
          const state = await database.getPilotBlock(operator.teacherUserId);
          const result = await assignCohorts(operator.teacherUserId, { seed: state.seed, reset: false });
          autoAssigned = result.added.length;
        }
      }
      await database.setPilotBlock(operator.teacherUserId, block, operator.session.user.id);
      const summary = await pilotSummary(operator.teacherUserId);
      if (!autoAssigned) return res.json(summary);
      // El estado (bloque y cuantos hay en cada grupo) ya viene en description
      // y counts: el aviso solo cuenta la asignacion y su semilla, que el
      // protocolo pide anotar.
      return res.json({
        ...summary,
        added: autoAssigned,
        assignedAutomatically: true,
        message: `Grupos A y B asignados automaticamente al iniciar el bloque (${autoAssigned} estudiantes; semilla: ${summary.seed}).`,
      });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 500;
      return res.status(status).json({ ok: false, error: errorMessage(error) });
    }
  });

  /** Para los clientes: el bloque y la condicion de quien pregunta (sin la lista del grupo). */
  app.get("/api/pilot/me", async (req, res) => {
    try {
      const session = await resolveSession(database, req).catch(() => null);
      if (!session) return res.status(401).json({ ok: false, error: "Sesion requerida." });
      const state = await database.getPilotStateForUser(session.user);
      return res.json({ ok: true, block: state.block, condition: state.condition, description: describePilotBlock(state.block) });
    } catch (error) {
      return res.status(500).json({ ok: false, error: errorMessage(error) });
    }
  });
}
