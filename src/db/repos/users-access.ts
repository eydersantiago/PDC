// AppDatabase: solicitudes de acceso de estudiantes (codigo o correo) y posibles duplicados.
// Metodos movidos sin cambios desde src/db/repos/users.ts; la clase va entre UsersDatabase y ManagedUsersDatabase.
import type { AppUser } from "../../types/app.js";
import { personNameTokens, personNameTokensMatch, type StudentAccessRequest } from "../../services/auth/student-code.js";
import { isSampleAccountId } from "../../services/accounts/sample-accounts.js";
import type { PossibleDuplicate, PossibleDuplicateGroup } from "../../services/progress/student-progress.js";
import { UsersDatabase } from "./users.js";

export class StudentAccessDatabase extends UsersDatabase {
  /**
   * Solicitudes pendientes de entrar con un correo nuevo a la cuenta de un codigo (0.7.22). El
   * docente ve las de sus estudiantes; el administrador, todas.
   */
  async listStudentAccessRequests(viewer: AppUser): Promise<StudentAccessRequest[]> {
    const result = await this.pool.query<{
      id: string;
      email: string;
      display_name: string;
      student_code: string;
      status: string;
      created_at: string | Date;
      target_user_id: string;
      source_user_id: string | null;
    }>(
      `
      select id, email, display_name, student_code, status, created_at, target_user_id, source_user_id
      from student_access_requests
      where status = 'pending'
      order by created_at asc
      `,
    );
    const requests: StudentAccessRequest[] = [];
    for (const row of result.rows) {
      const target = await this.findUserWithStatus(row.target_user_id);
      if (!target) continue;
      if (viewer.role === "teacher" && target.user.teacherUserId !== viewer.id) continue;
      if (viewer.role !== "teacher" && viewer.role !== "admin") continue;
      const source = row.source_user_id ? await this.findUserWithStatus(row.source_user_id) : null;
      // El docente no ve los datos de una cuenta de otro grupo (solo que existe).
      const foreignSource = !!source && viewer.role === "teacher" && source.user.teacherUserId !== viewer.id;
      requests.push({
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        studentCode: row.student_code,
        status: "pending",
        createdAt: new Date(row.created_at).toISOString(),
        target: {
          id: target.user.id,
          displayName: target.user.displayName,
          email: target.user.email,
          teacherUserId: target.user.teacherUserId,
        },
        source: source
          ? {
            id: foreignSource ? "" : source.user.id,
            displayName: foreignSource ? "Cuenta de otro grupo" : source.user.displayName,
            email: foreignSource ? "" : source.user.email,
            hasSignedIn: await this.hasEverSignedIn(source.user.id),
            otherGroup: foreignSource,
          }
          : null,
      });
    }
    return requests;
  }

  /**
   * Cuentas de estudiante que parecen de la misma persona (examen del 28-10-2026: la fila de la lista
   * con el Gmail de Campus, que nunca entro, y la cuenta nueva con la que entro el estudiante con su
   * correo institucional). Pares de estudiantes activos con el mismo nombre (personNamesMatch), sin
   * cuentas de muestra. Solo marca: no une ni mueve nada; unir sigue siendo decision del docente.
   * Un grupo por estudiante visible con sus posibles duplicados. El docente no ve los datos de una
   * cuenta de otro grupo (como en las solicitudes): sale como «Cuenta de otro grupo».
   */
  async listPossibleDuplicateStudents(viewer: AppUser): Promise<PossibleDuplicateGroup[]> {
    const found = new Map<string, PossibleDuplicateGroup>();
    if (viewer.role !== "teacher" && viewer.role !== "admin") return [];
    const [students, signedIn] = await Promise.all([
      this.pool.query<{ id: string; email: string; display_name: string; teacher_user_id: string | null }>(
        `select id, email, display_name, teacher_user_id from users where role_id = 'role-student' and is_active = true`,
      ),
      this.pool.query<{ user_id: string }>(`select distinct user_id from app_sessions`),
    ]);
    const entered = new Set(signedIn.rows.map((row) => row.user_id));
    const rows = students.rows.filter((row) => !isSampleAccountId(row.id));
    const tokens = rows.map((row) => personNameTokens(row.display_name));
    const visible = (row: { teacher_user_id: string | null }) => viewer.role === "admin" || row.teacher_user_id === viewer.id;
    const describe = (row: { id: string; email: string; display_name: string; teacher_user_id: string | null }, other: typeof row): PossibleDuplicate => {
      const foreign = !visible(other);
      const otherName = foreign ? "Cuenta de otro grupo" : other.display_name;
      const reason = entered.has(row.id) && !entered.has(other.id)
        ? `${otherName} tiene el mismo nombre y nunca ha entrado: puede ser su fila de la lista.`
        : !entered.has(row.id) && entered.has(other.id)
          ? `Nunca ha entrado; ${otherName} tiene el mismo nombre y si entro: puede estar trabajando en esa cuenta.`
          : `${otherName} tiene el mismo nombre.`;
      return { otherUserId: foreign ? "" : other.id, otherDisplayName: otherName, otherEmail: foreign ? "" : other.email, reason };
    };
    const add = (row: (typeof rows)[number], duplicate: PossibleDuplicate) => {
      const group = found.get(row.id) || { userId: row.id, displayName: row.display_name, email: row.email, hasSignedIn: entered.has(row.id), duplicates: [] };
      group.duplicates.push(duplicate);
      found.set(row.id, group);
    };
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i];
        const b = rows[j];
        if (!personNameTokensMatch(tokens[i], tokens[j])) continue;
        if (visible(a)) add(a, describe(a, b));
        if (visible(b)) add(b, describe(b, a));
      }
    }
    return [...found.values()];
  }

  /**
   * Aprobar: el correo pasa a ser otro acceso de la cuenta del codigo (y la cuenta que ya tenia
   * ese correo, si existe, se une a ella). Rechazar: ese correo con ese codigo no vuelve a pedir.
   */
  async decideStudentAccessRequest(requestId: string, decision: "approve" | "reject", viewer: AppUser, expectedStudentCode?: string | null) {
    const result = await this.pool.query<{
      id: string;
      email: string;
      status: string;
      student_code: string;
      target_user_id: string;
      source_user_id: string | null;
    }>(
      `select id, email, status, student_code, target_user_id, source_user_id from student_access_requests where id = $1 limit 1`,
      [requestId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Solicitud no encontrada.");
    if (row.status !== "pending") throw new Error("Esa solicitud ya se decidio.");
    // La solicitud de un correo se actualiza si vuelve con otro codigo: se decide la que se vio.
    if (expectedStudentCode && expectedStudentCode !== row.student_code) {
      throw new Error("La solicitud cambio mientras la mirabas: recarga la lista.");
    }
    if (viewer.role !== "teacher" && viewer.role !== "admin") throw new Error("Sin permiso.");
    const target = await this.findUserWithStatus(row.target_user_id);
    if (!target) throw new Error("La cuenta del codigo ya no existe.");
    if (viewer.role === "teacher" && target.user.teacherUserId !== viewer.id) {
      throw new Error("Solo puedes decidir solicitudes de tus estudiantes.");
    }
    if (decision === "approve") {
      if (!target.isActive) throw new Error("La cuenta del codigo esta desactivada: activala antes de aprobar.");
      // Lo de la solicitud tiene que seguir igual: el codigo en la misma cuenta y el correo sin
      // haber entrado a otra (si entro, por ejemplo con su propio codigo, ya no se une nada).
      if ((await this.getStudentCodeOwnerId(row.student_code)) !== row.target_user_id) {
        throw new Error("Ese codigo ya no es de esa cuenta: rechaza la solicitud.");
      }
      const current = await this.findLoginAccount(row.email);
      if (current && current.user.id !== row.target_user_id && current.user.id !== row.source_user_id) {
        throw new Error("Ese correo ya entra a otra cuenta: rechaza la solicitud.");
      }
      const source = row.source_user_id ? await this.findUserWithStatus(row.source_user_id) : null;
      if (source && viewer.role === "teacher" && source.user.teacherUserId !== viewer.id) {
        throw new Error("Ese correo ya tiene una cuenta de otro grupo: solo el administrador puede unirlas.");
      }
      await this.mergeLoginEmailInto({
        email: row.email,
        targetUserId: row.target_user_id,
        sourceUserId: row.source_user_id,
        approvedByUserId: viewer.id,
      });
    }
    const status = decision === "approve" ? "approved" : "rejected";
    await this.closePendingAccessRequest(row.email, status, viewer.id);
    return { id: row.id, status };
  }
}
