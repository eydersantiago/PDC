import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Simulacion del acceso simplificado con el proveedor "tunnel"
 * (docs/arquitectura/acceso-simplificado.md, seccion 4): se cargan los content scripts
 * REALES de la extension (orden de manifest.json) en node:vm con un chrome, un DOM y un
 * backend falsos y un reloj virtual. Cubre:
 *  - primera vez sin GitHub App: Conectar GitHub -> OAuth -> prepare (VM apagada,
 *    reintentable) -> codigo de dispositivo en una sola pestana -> editor listo;
 *  - volver otro dia: el overlay entra solo (sin "Empezar" ni pedir ayuda al tutor) y
 *    "Abrir mi editor" consulta status y abre;
 *  - "Abrir en VS Code de este equipo" y "Copiar sesion" con codigo de un solo uso;
 *  - la pagina /empezar detecta la extension;
 *  - auditoria de redundancias (0.7.12): sin «Empezar», privacidad aceptada en el backend,
 *    editor preparado en otro navegador, tunel sin GitHub App en la tuerca ni en las filas,
 *    vscode.dev sin textos de Codespaces, docente sin tour, un solo «Salir», ultima eleccion
 *    de editor en la Mac y sin botones ni peticiones repetidas;
 *  - tanda 2: Codespaces con boton unico (la GitHub App se detecta sola y se siguen creando
 *    el PR y el Codespace), una sola casilla de mini quiz y los avisos del backend al lanzar
 *    un quiz o iniciar un bloque del piloto, y Campus verificado en silencio con una accion.
 */

const EXT_ROOT = fileURLToPath(new URL("../../../browser-ext-prod/", import.meta.url));
export const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, "manifest.json"), "utf8"));
export const OVERLAY_SCRIPTS: string[] = MANIFEST.content_scripts[0].js;
export const SOURCES = new Map<string, string>(
  [...OVERLAY_SCRIPTS, "inicio/pagina-inicio.content.js"].map((rel) => [rel, fs.readFileSync(path.join(EXT_ROOT, rel), "utf8")]),
);

export const BACKEND = "https://app-adaceen-api-eyder05232002.azurewebsites.net";
export const REPO = "univalle-fpoo/taller-1";
export const TUNNEL_URL = "https://vscode.dev/tunnel/ws-alumno/home/ws-alumno/taller-1";
// El comando que el backend manda a docentes y administradores (otra VM: el navegador no lo trae escrito).
export const STAFF_VM_COMMAND = "gcloud compute ssh aula-ws --zone=southamerica-east1-b --tunnel-through-iap --command='sudo google_metadata_script_runner startup'";
export const CODESPACE_URL = "https://fluffy-space-xyz.github.dev/";
export const CAMPUS_COURSE_URL = "https://campusvirtual.univalle.edu.co/moodle/course/view.php?id=77";
export const SESSION = {
  id: "sess-browser-1",
  user: {
    id: "u-alumno",
    role: "student",
    email: "alumno@correounivalle.edu.co",
    displayName: "Alumno Prueba",
    assignedCourseCodes: ["FPOO"],
  },
};

export type Json = Record<string, unknown>;
export type Listener = (event: any) => unknown;
