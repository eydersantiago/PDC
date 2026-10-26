// Cabeceras con que los clientes de ADACEEN se identifican en cada llamada (contrato de la API,
// seccion 1). Los mismos nombres que en vscode-ext-prod/src/client-identity.ts.

/** Sesion de ADACEEN (tambien se acepta sessionId en el cuerpo o la cookie de sesion). */
export const SESSION_ID_HEADER = "x-session-id";
/** Id aleatorio del cliente sin sesion: la telemetria lo seudonimiza. */
export const CLIENT_ID_HEADER = "x-adaceen-client-id";
/** Version de la extension que llama (VS Code 0.0.37 o posterior). */
export const CLIENT_VERSION_HEADER = "x-adaceen-client-version";
/** Tipo de editor donde corre VS Code: local, tunnel, codespaces o remote (0.0.37 o posterior). */
export const EDITOR_HOST_HEADER = "x-adaceen-editor-host";
/**
 * Instancia que llama: los workers de escaneo y la extension de VS Code ("adaceen-vscode-<remoto>"
 * por defecto; VS Code 0.0.36 o anterior solo dice asi en que editor corre).
 */
export const WORKER_ID_HEADER = "x-adaceen-worker-id";
