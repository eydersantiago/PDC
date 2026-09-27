// AppDatabase, parte 1 de 12: base: pool y proveedor, cerrar, cursos asignados, sesiones de editor y ayudas comunes (roles, docente por defecto, politica).
// Metodos movidos sin cambios desde src/db/database.ts. Cadena: DatabaseCore -> AuthDatabase -> UsersDatabase -> PolicyDatabase -> RagLotsDatabase -> RagSourcesDatabase -> GithubDatabase -> WorkspaceDatabase -> PilotDatabase -> TelemetryDatabase -> ProgressDatabase -> QuizDatabase -> AppDatabase
// (cada clase extiende a la anterior; db.metodo() sigue igual). private pasa a protected solo si otra clase lo usa.
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { AppUser, UserRoleCode } from "../../types/app.js";
import { MAX_ACTIVE_EDITOR_SESSIONS, mapSessionRow, normalizeAssignedCourseCodes, normalizeSessionKind } from "../rows.js";
import type { CourseAssignmentRow, CreateSessionOptions, SessionRow } from "../rows.js";
import { DEFAULT_RAG_COURSE_CODE, normalizeRagCourseCodes } from "../../services/rag-courses.js";
import { trimText } from "../../services/text-utils.js";
import { seedTeacherPolicy } from "../seeds.js";

export class DatabaseCore {
  readonly pool: Pool;

  readonly provider: "postgres" | "memory-postgres";

  constructor(pool: Pool, provider: "postgres" | "memory-postgres") {
    this.pool = pool;
    this.provider = provider;
  }

  async close() {
    await this.pool.end();
  }

  protected async listAssignedCourseCodesForUser(userId: string, role: UserRoleCode = "student") {
    const result = await this.pool.query<CourseAssignmentRow>(
      `
      select user_id, course_code
      from user_course_assignments
      where user_id = $1
      order by
        case course_code when $2 then 0 else 1 end,
        course_code asc
      `,
      [userId, DEFAULT_RAG_COURSE_CODE],
    );

    return normalizeAssignedCourseCodes(result.rows.map((row) => row.course_code), role);
  }

  protected async setUserCourseAssignments(
    userId: string,
    courseCodes: unknown,
    assignedByUserId: string | null,
  ) {
    const codes = normalizeRagCourseCodes(courseCodes, {
      fallbackToDefault: true,
      knownOnly: true,
    });

    await this.pool.query(
      `delete from user_course_assignments where user_id = $1`,
      [userId],
    );

    for (const courseCode of codes) {
      await this.pool.query(
        `
        insert into user_course_assignments (
          id,
          user_id,
          course_code,
          assigned_by_user_id,
          created_at
        )
        values ($1, $2, $3, $4, now())
        on conflict (user_id, course_code) do nothing
        `,
        [randomUUID(), userId, courseCode, assignedByUserId],
      );
    }

    return codes;
  }

  protected async createSessionForUser(user: AppUser, options: CreateSessionOptions = {}) {
    const sessionId = randomUUID();
    const kind = normalizeSessionKind(options.kind);
    const label = trimText(options.label) || null;
    const expiresAt = options.expiresAt || null;
    const previousSessions = await this.pool.query<{ count: string }>(
      `select count(*)::text as count from app_sessions where user_id = $1`,
      [user.id],
    );
    if (kind !== "editor") {
      // Un inicio de sesion solo desactiva las sesiones de su tipo: entrar en
      // el navegador ya no deja a VS Code (sesion editor) sin sesion.
      await this.pool.query(
        `update app_sessions set is_active = false where user_id = $1 and kind = $2`,
        [user.id, kind],
      );
    }
    const inserted = await this.pool.query<SessionRow>(
      `
      insert into app_sessions (id, user_id, kind, expires_at, label)
      values ($1, $2, $7, $8, $9)
      returning
        id as session_id,
        created_at,
        last_seen_at,
        kind,
        expires_at,
        label,
        $2::text as user_id,
        $3::text as role,
        $4::text as email,
        $5::text as display_name,
        $6::text as teacher_user_id
      `,
      [
        sessionId,
        user.id,
        user.role,
        user.email,
        user.displayName,
        user.teacherUserId,
        kind,
        expiresAt,
        label,
      ],
    );
    const row = inserted.rows[0];
    row.assigned_course_codes = await this.listAssignedCourseCodesForUser(user.id, user.role);
    if (kind === "editor") {
      await this.pruneEditorSessions(user.id, sessionId);
    }

    return {
      ...mapSessionRow(row),
      isFirstLogin: Number(previousSessions.rows[0]?.count || 0) === 0,
    };
  }

  // Deja activas solo MAX_ACTIVE_EDITOR_SESSIONS sesiones editor: la recien
  // creada, la del tunel mas reciente (prepare la reutiliza, asi que suele ser
  // la mas vieja, y VS Code del tunel la lee del archivo que escribio la VM) y
  // las usadas mas recientemente (getSession actualiza last_seen_at).
  private async pruneEditorSessions(userId: string, keepSessionId: string) {
    const active = await this.pool.query<{ id: string; label: string | null; expires_at: string | Date | null }>(
      `
      select id, label, expires_at
      from app_sessions
      where user_id = $1
        and kind = 'editor'
        and is_active = true
      order by last_seen_at desc, created_at desc
      `,
      [userId],
    );
    const tunnel = active.rows
      .filter((item) => item.label === "tunnel")
      .sort((a, b) => new Date(b.expires_at || 0).getTime() - new Date(a.expires_at || 0).getTime())[0];
    const keep = new Set([keepSessionId, tunnel?.id].filter(Boolean));
    const extra = active.rows
      .map((item) => item.id)
      .filter((id) => !keep.has(id))
      .slice(Math.max(0, MAX_ACTIVE_EDITOR_SESSIONS - keep.size));
    for (const id of extra) {
      await this.pool.query(`update app_sessions set is_active = false where id = $1`, [id]);
    }
  }

  protected async getRoleIdByCode(roleCode: UserRoleCode) {
    const result = await this.pool.query<{ id: string }>(
      `
      select id
      from roles
      where code = $1
      limit 1
      `,
      [roleCode],
    );
    const roleId = result.rows[0]?.id;
    if (!roleId) {
      throw new Error(`Rol no encontrado: ${roleCode}`);
    }
    return roleId;
  }

  protected async resolveTeacherUserId(
    candidateTeacherUserId: string | null | undefined,
    options?: {
      excludeUserId?: string;
    },
  ) {
    const candidate = String(candidateTeacherUserId || "").trim();
    const excludedUserId = String(options?.excludeUserId || "").trim();
    if (candidate) {
      if (excludedUserId && candidate === excludedUserId) {
        throw new Error("Debes asignar un profesor diferente al usuario que se esta editando.");
      }
      const checkTeacher = await this.pool.query<{ id: string }>(
        `
        select u.id
        from users u
        join roles r on r.id = u.role_id
        where u.id = $1
          and u.is_active = true
          and r.code = 'teacher'
        limit 1
        `,
        [candidate],
      );
      if (!checkTeacher.rows[0]) {
        throw new Error("teacherUserId invalido. Debe ser un profesor activo.");
      }
      return candidate;
    }

    const defaultTeacherId = await this.getDefaultTeacherId(excludedUserId);
    if (!defaultTeacherId) {
      throw new Error("No hay profesores activos para asignar al estudiante.");
    }
    return defaultTeacherId;
  }

  protected async ensureTeacherPolicyExists(teacherUserId: string) {
    await this.pool.query(
      `
      insert into teacher_policies (
        id,
        teacher_user_id,
        policy_name,
        outcome,
        tone,
        frequency,
        help_level,
        allow_mini_quiz,
        strict_no_solution,
        max_hints_per_exercise,
        fallback_message,
        custom_instruction,
        allowed_interventions,
        allowed_topics,
        event_rules
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb)
      on conflict (teacher_user_id) do nothing
      `,
      [
        randomUUID(),
        teacherUserId,
        seedTeacherPolicy.policyName,
        seedTeacherPolicy.outcome,
        seedTeacherPolicy.tone,
        seedTeacherPolicy.frequency,
        seedTeacherPolicy.helpLevel,
        seedTeacherPolicy.allowMiniQuiz,
        seedTeacherPolicy.strictNoSolution,
        seedTeacherPolicy.maxHintsPerExercise,
        seedTeacherPolicy.fallbackMessage,
        seedTeacherPolicy.customInstruction,
        JSON.stringify(seedTeacherPolicy.allowedInterventions),
        JSON.stringify(seedTeacherPolicy.allowedTopics),
        JSON.stringify(seedTeacherPolicy.eventRules),
      ],
    );
  }

  protected async getDefaultTeacherId(excludeUserId?: string) {
    const excluded = String(excludeUserId || "").trim();
    const result = await this.pool.query<{ id: string }>(
      `
      select u.id
      from users u
      join roles r on r.id = u.role_id
      where r.code = 'teacher'
        and u.is_active = true
        and ($1 = '' or u.id <> $1)
      order by u.created_at asc
      limit 1
      `,
      [excluded],
    );

    return result.rows[0]?.id || null;
  }
}
