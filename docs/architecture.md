# Arquitectura ADACEEN

Este workspace agrupa tres componentes que trabajan juntos:

## Backend proxy (`agente-proxy-azure`)

Servidor Express en TypeScript. Expone autenticacion, politicas docentes, integracion con GitHub App, escaneos de proyecto y endpoints de IA.

- Punto de entrada: `server.ts`
- App Express: `src/app.ts`
- Rutas HTTP: `src/routes/register-routes.ts`
- Configuracion: `src/config/env.ts`
- Base de datos: `src/db/*`
- Servicios de dominio: `src/services/*`
- Tipos compartidos internos: `src/types/*`

Buenas practicas para nuevos cambios:

- Mantener `register-routes.ts` solo como cableado HTTP cuando sea posible.
- Mover prompts, parseadores, heuristicas y clientes externos a `src/services`.
- Leer variables de entorno solo desde `src/config/env.ts`.
- Evitar commitear datos runtime bajo `data/`, capturas, zips o builds.

## Extension de navegador (`browser-ext-prod`)

Extension Manifest V3 para Chrome/Edge. Lee el contexto de Campus Virtual, GitHub y Codespaces, y consulta el backend.

- Manifest: `manifest.json`
- Service worker: `background.js`
- Script inyectado/overlay: `content.js`
- Popup legado: `popup.html`, `popup.js`, `popup.css`

Buenas practicas para nuevos cambios:

- Mantener permisos del manifest lo mas especificos posible.
- Separar helpers puros de logica DOM si el archivo `content.js` sigue creciendo.
- Conservar fallbacks locales cuando el backend no responda.

## Extension VS Code (`vscode-ext-prod`)

Extension VS Code que escanea el workspace y actua como worker para solicitudes del backend.

- Fuente principal: `src/extension.ts`
- Build webpack: `webpack.config.js`
- Artefactos generados: `dist/`, `out/`, `*.vsix`

Buenas practicas para nuevos cambios:

- No editar `out/` ni `dist/` directamente; modificar `src/extension.ts` y compilar.
- Mantener limites de escaneo configurables desde `package.json` o variables `ADACEEN_*`.
- Reportar errores al backend sin romper el ciclo del worker.
