# Agente Proxy & Extensión de Navegador Integrada

Este repositorio contiene la arquitectura cliente-servidor de una solución basada en inteligencia artificial (Proxy + Extensión), dividida en dos componentes principales: un servidor proxy desarrollado en Node.js/TypeScript y una extensión de navegador web.

## 📂 Estructura del Proyecto

* **`agente-proxy-azure/`**
  Este directorio contiene el backend proxy construido para interactuar con servicios de Azure / APIs y procesar flujos de trabajo de IA.
  * **Lenguaje:** TypeScript (`server.ts`, `runWorkflow.ts`, etc.)
  * **Capacidades:** Procesamiento de texto (`runText.ts`), visión e imágenes (`vision.ts`, `runImage.ts`), y flujos de trabajo sugeridos.
  * **Configuración:** Administra variables de entorno base (`.env.example`) y dependencias mediante `package.json`.

* **`browser-ext-prod/`**
  Este directorio alberga el código fuente de la extensión de navegador.
  * **Archivos Core:** `manifest.json` (configuración principal), `background.js` (Service Worker) y `content.js` (scripts inyectados a las páginas web).
  * **Interfaz:** Ventana emergente proporcionada por `popup.html`, `popup.js`, y `popup.css`.

* **`Recursos/`**
  Documentación adicional y archivos formales de soporte o requerimientos asociados al proyecto.

## 🚀 Instalación y Uso

### 1. Servidor Proxy (agente-proxy-azure)
1. Navega a la carpeta backend:
   ```bash
   cd agente-proxy-azure
   ```
2. Instala las dependencias:
   ```bash
   npm install
   ```
3. Configura tus variables de entorno creando un archivo `.env` basado en `.env.example`.
4. Ejecuta el servidor (utilizando tu script de inicio configurado en `package.json`).

### 2. Extensión de Navegador (browser-ext-prod)
1. Abre tu navegador basado en Chromium (Google Chrome, Microsoft Edge, Brave, etc.).
2. Accede a la página de extensiones (por ejemplo, `chrome://extensions/`).
3. Activa el **Modo de desarrollador**.
4. Haz clic en **"Cargar descomprimida"** y selecciona la carpeta `browser-ext-prod`.
5. La extensión ya debería estar visible y lista para interactuar con el proxy en ejecución.

## 🛡️ Gitignore
El proyecto cuenta con un `.gitignore` integral para proyectos de Node.js, configurado para ignorar directorios como `node_modules/`, volcados de depuración, directorios de caché de builds (TypeScript) y la carpeta de subidas en el backend (`agente-proxy-azure/uploads/`).
