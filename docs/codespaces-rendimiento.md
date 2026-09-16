# Rendimiento de Codespaces en ADACEEN

Guía de por qué los Codespaces del proyecto arrancaban lento, qué se cambió en
el repo y qué falta hacer desde la interfaz de GitHub (no se puede versionar).

## Diagnóstico

| # | Causa | Estado |
|---|---|---|
| 1 | `master` no tenía `.devcontainer/`: Codespaces caía a la imagen por defecto | Corregido |
| 2 | La rama `adaceen/devcontainer-bootstrap-mp2twl1h` usaba `universal:2` (~10 GB) | Corregido |
| 3 | `vscode-ext-prod` usaba `base:ubuntu-24.04`, que **no trae Node** | Corregido |
| 4 | `install-extensions.sh` corría en cada *attach* vía `postAttachCommand` | Corregido |
| 5 | Clave `extensions` de primer nivel: obsoleta, no hacía nada | Corregido |
| 6 | ~11.6 MB de binarios innecesarios versionados | Corregido |
| 7 | `adaceen.backend.baseUrl` apuntaba a `127.0.0.1:3000` para estudiantes | Corregido |
| 8 | Sin prebuilds | **Pendiente: requiere la UI de GitHub** |

## Cambios aplicados en el repo

### Imagen del devcontainer

`universal:2` trae Python, Java, Ruby, PHP, Go, .NET y Conda. El backend es
Node 22 + TypeScript. Ahora ambos repos usan
`mcr.microsoft.com/devcontainers/typescript-node:22-bookworm`.

Los tres perfiles comparten la misma imagen a propósito: las capas quedan en
caché del host, así que el segundo perfil arranca sin descargar nada.

### Dos perfiles, dos públicos

- `.devcontainer/devcontainer.json` — **desarrollo**. 4 núcleos, `npm ci`,
  puerto 3000 reenviado, `baseUrl` en loopback (el backend corre *dentro* del
  Codespace).
- `.devcontainer/estudiante/devcontainer.json` — **participantes del estudio**.
  2 núcleos, sin `npm ci`, `baseUrl` apuntando al App Service.

Al crear un Codespace, elegir el perfil con **Code → Codespaces → New with
options… → Dev container configuration**.

El perfil de estudiante existe porque el participante no compila el backend:
edita y recibe sugerencias. Quitarle el `npm ci` y bajarlo a 2 núcleos reduce a
la mitad el consumo de core-hours durante el experimento.

### `onCreateCommand` en vez de `postCreateCommand`

`onCreateCommand` y `updateContentCommand` quedan **horneados en el prebuild**;
`postCreateCommand` no. Por eso el `npm ci` va en `onCreateCommand`: con
prebuild activo, las dependencias ya vienen resueltas en el snapshot.

### Extensiones sin script

`install-extensions.sh` corría en `postCreateCommand`, `postAttachCommand` y
`updateContentCommand`. `postAttachCommand` se ejecuta **cada vez que reabres o
reconectas** el Codespace, y hacía `code --install-extension` contra el
Marketplace: segundos perdidos en cada reapertura.

Se eliminó el script. `customizations.vscode.extensions` ya instala las
extensiones en la creación, que es el mecanismo soportado.

La clave `extensions` de primer nivel que tenían ambos repos era configuración
muerta: la especificación la movió a `customizations.vscode.extensions` hace
años.

### Peso del repositorio

| Archivo | Antes | Después |
|---|---|---|
| `browser-ext-prod/icon-16.png` | 2.52 MB (1536×1024) | 1.0 KB (16×16) |
| `browser-ext-prod/icon-48.png` | 3.07 MB (1536×1024) | 6.1 KB (48×48) |
| `browser-ext-prod/icon-128.png` | 3.46 MB (1536×1024) | 32.3 KB (128×128) |
| `assets/codespace-bg-lake` | 1.37 MB PNG | 237 KB JPEG |
| `assets/codespace-bg-mountains` | 1.08 MB PNG | 114 KB JPEG |
| `eng.traineddata` + `spa.traineddata` | 8.5 MB | 0 (descarga en runtime) |

**Total: ~20 MB → ~390 KB.**

Los tres iconos eran la misma ilustración de 1536×1024 guardada tres veces.
Chrome los reescalaba en cada carga de la extensión, así que además
ralentizaban el navegador. Ahora son recortes cuadrados centrados en las
dimensiones que declara el `manifest.json`.

> Nota: a 16×16 la ilustración completa se lee mal. Un icono diseñado para ese
> tamaño (una marca simple, no una escena) sería mejor, pero eso es trabajo de
> diseño, no de optimización.

Los fondos eran fotografías guardadas en PNG, el peor formato posible para
fotos. Pasaron a JPEG con calidad 82 (−83% y −90%) y se actualizaron las
referencias en `manifest.json` y `codespace-waiting-window.service.js`.

### Modelos de OCR

`eng.traineddata` y `spa.traineddata` estaban versionados **por accidente**:
`Tesseract.recognize()` se llamaba sin `cachePath`, así que tesseract.js
descargaba los modelos al *cwd* — la raíz del repo — y de ahí se commitearon.

Ahora `document-classifier.ts` fija un `cachePath` explícito y `.gitignore`
incluye `*.traineddata`, de modo que no vuelven a colarse.

El default es el directorio temporal del sistema, no el del repo, porque
`wwwroot` puede ser de solo lectura en App Service con
`WEBSITE_RUN_FROM_PACKAGE`. Para no re-descargar los modelos en cada reinicio
del contenedor, definir en App Service:

```
DOCUMENT_OCR_CACHE_PATH=/home/data/tesseract
```

(`/home` es persistente y escribible en Azure App Service.)

## Pendiente: activar prebuilds

**Los prebuilds no se pueden versionar.** No existe API pública ni archivo de
configuración: son un ajuste del repositorio en la interfaz web. Hay que
hacerlo a mano, una vez por repo.

Es la palanca de mayor impacto: GitHub deja el contenedor, el clon y las
dependencias listos en un snapshot, y la creación pasa de minutos a decenas de
segundos. GitHub lo recomienda para cualquier repo que tarde más de dos minutos
en inicializar.

Pasos, en `eydersantiago/PDC` y en `eydersantiago/vscode-ext-prod`:

1. **Settings → Codespaces → Prebuild configurations → Set up prebuild**
2. *Configuration file*: `.devcontainer/devcontainer.json`
   (crear una segunda para `.devcontainer/estudiante/devcontainer.json`)
3. *Region*: la misma donde se crean los Codespaces
4. *Trigger*: `On push` a `master`
5. **Marcar la casilla de submódulos** en PDC — el repo incluye
   `vscode-ext-prod` como submódulo y sin eso el prebuild no lo trae
6. *Template history*: 2 versiones basta

Consume minutos de Actions y almacenamiento facturable.

## Si sigue sintiéndose lento

Antes de culpar al entorno, descartar la cadena de inferencia:

- Con `AGENT_TARGET=queue` y `QUEUE_REQUEST_TIMEOUT_MS=120000`, si el worker de
  Ollama no está corriendo, cada petición espera **dos minutos** antes de
  fallar. Eso se percibe como "el Codespace está lentísimo" aunque el editor
  vaya perfecto. Ver [service-bus-ollama-worker.md](service-bus-ollama-worker.md).
- Trabajar desde VS Code de escritorio conectado al Codespace, no desde la
  pestaña del navegador: elimina la latencia por pulsación del cliente web.

## Alternativa: github.dev para el carril liviano

`webpack.config.js` de `vscode-ext-prod` ya compila un `webExtensionConfig` con
`target: 'webworker'`, y el `package.json` declara
`"browser": "./dist/web/extension.js"`. **La extensión ya corre en el editor
web**: abrir el repo en GitHub y pulsar `.`.

Arranca en ~1 segundo, no consume cuota de Codespaces y no requiere que el
participante espere nada. El límite es que no hay terminal ni ejecución de
código.

Eso permite un modelo de dos niveles: github.dev para observación y
sugerencias, Codespaces (con prebuild) solo cuando el estudiante necesita
ejecutar.
