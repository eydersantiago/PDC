import fs from 'fs';
import path from 'path';

const VAULT_ROOT = 'C:\\Users\\Eyder\\Documents\\Obsidian Vault';
const ADACEEN_DIR = path.join(VAULT_ROOT, 'ADACEEN');
const REPO_ROOT = 'E:\\Univalle\\16. Décimo Semestre\\TGII\\Código\\PDC';
const INFORMES_ROOT = 'E:\\Univalle\\16. Décimo Semestre\\TGII\\Informes ADACEEN';

// File registry with metadata
const DOCUMENTS = [
  // 01 - Arquitectura
  {
    src: path.join(REPO_ROOT, 'docs/arquitectura/adr-001-motor-y-arquitectura.md'),
    destFolder: '01 - Arquitectura y Diseño',
    destFile: 'adr-001-motor-y-arquitectura.md',
    title: 'ADR-001: Motor de Políticas y Cambio de Arquitectura',
    categoria: 'Arquitectura',
    jira: 'A9.6 · ADACEEN-88',
    tags: ['arquitectura', 'adr', 'politicas', 'adaceen-88'],
    desc: 'Decisión arquitectónica de reemplazo del motor monolítico por reglas desacopladas y RAG.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/arquitectura/ruta-de-datos.md'),
    destFolder: '01 - Arquitectura y Diseño',
    destFile: 'ruta-de-datos.md',
    title: 'Ruta de Datos de ADACEEN',
    categoria: 'Arquitectura',
    jira: 'A7.5 · ADACEEN-73',
    tags: ['arquitectura', 'datos', 'privacidad', 'adaceen-73', 'diagrama'],
    desc: 'Detalle de los 17 tramos de datos, clasificación de datos personales/seudonimizados y retención.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/arquitectura/vistas.md'),
    destFolder: '01 - Arquitectura y Diseño',
    destFile: 'vistas.md',
    title: 'Vistas de Arquitectura: C4 y Secuencias',
    categoria: 'Arquitectura',
    jira: 'A9.6 · ADACEEN-88, A16.2',
    tags: ['arquitectura', 'c4', 'secuencia', 'adaceen-88'],
    desc: 'Diagramas de contenedores (C4 nivel 2) y flujos de secuencia de interacción estudiante-tutor-GPU.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/arquitectura/contrato-api.md'),
    destFolder: '01 - Arquitectura y Diseño',
    destFile: 'contrato-api.md',
    title: 'Contrato de la API de ADACEEN',
    categoria: 'Arquitectura',
    jira: 'A9.6 · ADACEEN-88, A16.2',
    tags: ['arquitectura', 'api', 'contrato', 'endpoints'],
    desc: 'Especificación técnica verificada de todos los endpoints REST, payloads y códigos de estado.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/arquitectura/acceso-simplificado.md'),
    destFolder: '01 - Arquitectura y Diseño',
    destFile: 'acceso-simplificado.md',
    title: 'Acceso Simplificado: Emparejamiento del Editor',
    categoria: 'Arquitectura',
    jira: 'A15.3 · ADACEEN-124',
    tags: ['arquitectura', 'vscode', 'emparejamiento', 'adaceen-124'],
    desc: 'Mecanismo de conexión sin comandos de terminal entre la extensión del navegador y el editor.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/flujo-sugerencias.md'),
    destFolder: '01 - Arquitectura y Diseño',
    destFile: 'flujo-sugerencias.md',
    title: 'Flujo de Sugerencias y Generación LLM',
    categoria: 'Arquitectura',
    jira: '—',
    tags: ['arquitectura', 'sugerencias', 'llm', 'flujo'],
    desc: 'Ciclo completo de vida de una solicitud de sugerencia pedagógica desde el editor hasta el LLM.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/service-bus-ollama-worker.md'),
    destFolder: '01 - Arquitectura y Diseño',
    destFile: 'service-bus-ollama-worker.md',
    title: 'Worker de Inferencia con Service Bus y Ollama',
    categoria: 'Arquitectura',
    jira: 'A15.8 · ADACEEN-148, A15.10 · ADACEEN-151',
    tags: ['arquitectura', 'gpu', 'service-bus', 'ollama', 'worker'],
    desc: 'Arquitectura desacoplada de colas en Azure Service Bus y workers GPU (GCP L4 y Mac laboratorio).'
  },
  {
    src: path.join(REPO_ROOT, 'docs/workspaces-tunnel.md'),
    destFolder: '01 - Arquitectura y Diseño',
    destFile: 'workspaces-tunnel.md',
    title: 'Entornos de Trabajo con VS Code Tunnels y Relay',
    categoria: 'Arquitectura',
    jira: 'A15.3 · ADACEEN-124',
    tags: ['arquitectura', 'tunnels', 'vscode', 'relay'],
    desc: 'Configuración de Dev Tunnels para servir entornos Linux sin IP pública expuesta.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/workspaces-serve-web.md'),
    destFolder: '01 - Arquitectura y Diseño',
    destFile: 'workspaces-serve-web.md',
    title: 'Spike: VS Code Web con serve-web sin Código de Dispositivo',
    categoria: 'Arquitectura',
    jira: '—',
    tags: ['arquitectura', 'serve-web', 'spike', 'vscode'],
    desc: 'Investigación técnica para omitir pantallas de autorización de GitHub mediante code serve-web.'
  },

  // 02 - Tutor Pedagógico
  {
    src: path.join(REPO_ROOT, 'docs/tutor/escenarios.md'),
    destFolder: '02 - Tutor Pedagógico',
    destFile: 'escenarios.md',
    title: 'Escenarios Pedagógicos S1–S5',
    categoria: 'Tutor Pedagógico',
    jira: 'A9.5 · ADACEEN-87, A11.4 · ADACEEN-100',
    tags: ['tutor', 'pedagogia', 'escenarios', 'adaceen-87'],
    desc: 'Definición de los 5 escenarios pedagógicos (error de sintaxis, lógica, bloqueo, consulta, quiz).'
  },
  {
    src: path.join(REPO_ROOT, 'docs/tutor/plantillas-intervencion.md'),
    destFolder: '02 - Tutor Pedagógico',
    destFile: 'plantillas-intervencion.md',
    title: 'Plantillas de Intervención y Guardarraíles',
    categoria: 'Tutor Pedagógico',
    jira: 'A8.3, A8.4, A10.1, A10.2',
    tags: ['tutor', 'prompts', 'guardarrailes', 'plantillas'],
    desc: 'Prompts estructurados y reglas para evitar dar respuestas directas o código completo al estudiante.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/tutor/matriz-escenario-recurso.md'),
    destFolder: '02 - Tutor Pedagógico',
    destFile: 'matriz-escenario-recurso.md',
    title: 'Matriz Escenario → Recurso Autorizado',
    categoria: 'Tutor Pedagógico',
    jira: 'A8.6 · ADACEEN-81',
    tags: ['tutor', 'rag', 'recursos', 'adaceen-81'],
    desc: 'Mapeo entre tipo de problema del estudiante y fragmentos teóricos/material oficial del curso.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/tutor/banco-quiz.md'),
    destFolder: '02 - Tutor Pedagógico',
    destFile: 'banco-quiz.md',
    title: 'Banco de Preguntas del Mini-Quiz',
    categoria: 'Tutor Pedagógico',
    jira: 'A8.5 · ADACEEN-80',
    tags: ['tutor', 'quiz', 'preguntas', 'fpoo', 'adaceen-80'],
    desc: 'Preguntas diagnósticas de opción múltiple para evaluar conceptos clave de POO.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/tutor/revision-banco-quiz.md'),
    destFolder: '02 - Tutor Pedagógico',
    destFile: 'revision-banco-quiz.md',
    title: 'Revisión Docente del Banco de Quices',
    categoria: 'Tutor Pedagógico',
    jira: 'A8.7 · ADACEEN-82',
    tags: ['tutor', 'quiz', 'revision-docente', 'adaceen-82'],
    desc: 'Retroalimentación y validación del banco de quices por parte de docentes de FPOO.'
  },

  // 03 - Piloto y Métricas
  {
    src: path.join(REPO_ROOT, 'docs/piloto/README.md'),
    destFolder: '03 - Piloto Experimental y Métricas',
    destFile: 'piloto-README.md',
    title: 'Índice General del Piloto Experimental',
    categoria: 'Piloto Experimental y Métricas',
    jira: 'A13, A14',
    tags: ['piloto', 'indice', 'metodologia'],
    desc: 'Marco general, fases y cronograma del experimento pedagógico en el curso de FPOO.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/piloto/validacion-director.md'),
    destFolder: '03 - Piloto Experimental y Métricas',
    destFile: 'validacion-director.md',
    title: 'Paquete de Validación para el Director y Docente',
    categoria: 'Piloto Experimental y Métricas',
    jira: 'A5.7 · ADACEEN-61',
    tags: ['piloto', 'director', 'validacion', 'adaceen-61'],
    desc: 'Resumen ejecutivo y aval institucional para la realización del piloto experimental.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/piloto/protocolo.md'),
    destFolder: '03 - Piloto Experimental y Métricas',
    destFile: 'protocolo.md',
    title: 'Protocolo Experimental (Diseño Cruzado AB/BA)',
    categoria: 'Piloto Experimental y Métricas',
    jira: 'A13.1 · ADACEEN-109, A13.6 · ADACEEN-114',
    tags: ['piloto', 'protocolo', 'cruzado', 'ab-ba', 'adaceen-109'],
    desc: 'Diseño experimental con grupo de control e intervención cruzada en dos sesiones.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/piloto/instrumentos.md'),
    destFolder: '03 - Piloto Experimental y Métricas',
    destFile: 'instrumentos.md',
    title: 'Instrumentos de Evaluación y Cuestionarios',
    categoria: 'Piloto Experimental y Métricas',
    jira: 'A13.2 · ADACEEN-110',
    tags: ['piloto', 'encuestas', 'sus', 'likert', 'adaceen-110'],
    desc: 'Formularios pre y post prueba, escala SUS de usabilidad y preguntas Likert.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/piloto/consentimiento.md'),
    destFolder: '03 - Piloto Experimental y Métricas',
    destFile: 'consentimiento.md',
    title: 'Consentimiento Informado y Logística',
    categoria: 'Piloto Experimental y Métricas',
    jira: 'A13.3 · ADACEEN-111',
    tags: ['piloto', 'etica', 'consentimiento', 'adaceen-111'],
    desc: 'Formato ético de participación voluntaria conforme a directrices de Univalle.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/piloto/checklist-cumplimiento.md'),
    destFolder: '03 - Piloto Experimental y Métricas',
    destFile: 'checklist-cumplimiento.md',
    title: 'Lista de Cumplimiento Técnico del Piloto',
    categoria: 'Piloto Experimental y Métricas',
    jira: 'A13.4 · ADACEEN-112',
    tags: ['piloto', 'checklist', 'verificacion', 'adaceen-112'],
    desc: 'Verificación automatizada de salud del sistema previo al inicio del piloto.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/piloto/plan-de-soporte.md'),
    destFolder: '03 - Piloto Experimental y Métricas',
    destFile: 'plan-de-soporte.md',
    title: 'Plan de Soporte en Vivo Durante la Sesión',
    categoria: 'Piloto Experimental y Métricas',
    jira: 'A13.5 · ADACEEN-113',
    tags: ['piloto', 'soporte', 'incidencias', 'adaceen-113'],
    desc: 'Mecanismos de resolución rápida de problemas técnicos durante la clase en el laboratorio.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/piloto/prueba-inicio-a-fin.md'),
    destFolder: '03 - Piloto Experimental y Métricas',
    destFile: 'prueba-inicio-a-fin.md',
    title: 'Prueba de Inicio a Fin del Acceso Simplificado',
    categoria: 'Piloto Experimental y Métricas',
    jira: 'A15.3 · ADACEEN-124, A13.6 · ADACEEN-114, A16.8 · ADACEEN-150',
    tags: ['piloto', 'simulacro', 'e2e', 'adaceen-124'],
    desc: 'Ensayo con 2 cuentas completas validando el indicador T10 (<15 minutos de instalación).'
  },
  {
    src: path.join(REPO_ROOT, 'docs/piloto/pendientes.md'),
    destFolder: '03 - Piloto Experimental y Métricas',
    destFile: 'pendientes.md',
    title: 'Matriz de Pendientes y Responsables',
    categoria: 'Piloto Experimental y Métricas',
    jira: 'A5.7 · ADACEEN-61, A13, A14, A15',
    tags: ['piloto', 'gestion', 'pendientes'],
    desc: 'Asignación de tareas entre tesista, director de grado, docente titular y sistemas.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/piloto/analisis-de-datos.md'),
    destFolder: '03 - Piloto Experimental y Métricas',
    destFile: 'analisis-de-datos.md',
    title: 'Plan de Análisis de Datos del Piloto',
    categoria: 'Piloto Experimental y Métricas',
    jira: 'A14.2, A14.3, A14.4, A14.7',
    tags: ['piloto', 'estadistica', 'analisis', 'shapiro-wilk', 'wilcoxon'],
    desc: 'Metodología estadística para contrastar hipótesis de aprendizaje y usabilidad.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/metricas/catalogo-kpis.md'),
    destFolder: '03 - Piloto Experimental y Métricas',
    destFile: 'catalogo-kpis.md',
    title: 'Catálogo de KPIs del Sistema',
    categoria: 'Piloto Experimental y Métricas',
    jira: 'A3.1 a A3.6',
    tags: ['metricas', 'kpis', 'pedagogicos', 'tecnicos', 'usabilidad'],
    desc: 'Definición de las 20 métricas clave: pedagógicas (P1-P7), técnicas (T1-T10) y de usabilidad (U1-U3).'
  },

  // 04 - Telemetría y Datos
  {
    src: path.join(REPO_ROOT, 'docs/telemetria/diccionario-eventos.md'),
    destFolder: '04 - Telemetría y Datos',
    destFile: 'diccionario-eventos.md',
    title: 'Diccionario de Eventos de Telemetría',
    categoria: 'Telemetría y Datos',
    jira: 'A4.1, A4.3, A4.4',
    tags: ['telemetria', 'eventos', 'esquema', 'json'],
    desc: 'Catálogo formal de todos los eventos registrados por la extensión y el backend.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/telemetria/revision-tecnica.md'),
    destFolder: '04 - Telemetría y Datos',
    destFile: 'revision-tecnica.md',
    title: 'Revisión Técnica y Cierre del Diccionario',
    categoria: 'Telemetría y Datos',
    jira: 'A4.7, A4.2, A4.5, A7.1',
    tags: ['telemetria', 'revision', 'cumplimiento'],
    desc: 'Aprobación técnica de los tipos de datos, cardinalidad y volumen esperado de eventos.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/telemetria/trazabilidad-decisiones.md'),
    destFolder: '04 - Telemetría y Datos',
    destFile: 'trazabilidad-decisiones.md',
    title: 'Trazabilidad de las Decisiones del Tutor',
    categoria: 'Telemetría y Datos',
    jira: 'A5.5 · ADACEEN-59',
    tags: ['telemetria', 'auditoria', 'decisiones', 'adaceen-59'],
    desc: 'Mecanismo para auditar por qué el tutor sugirió una pista específica a un estudiante.'
  },

  // 05 - Pruebas y Evidencias
  {
    src: path.join(REPO_ROOT, 'docs/pruebas/plan-de-pruebas.md'),
    destFolder: '05 - Pruebas y Evidencias',
    destFile: 'plan-de-pruebas.md',
    title: 'Plan General de Pruebas de Software',
    categoria: 'Pruebas y Evidencias',
    jira: 'A12.1 · ADACEEN-103',
    tags: ['pruebas', 'qa', 'plan', 'adaceen-103'],
    desc: 'Estrategia de pruebas unitarias, de integración, contrato y pruebas de carga.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/evidencias/demo-escenarios.md'),
    destFolder: '05 - Pruebas y Evidencias',
    destFile: 'demo-escenarios.md',
    title: 'Evidencia: Ejecución de Escenarios S1–S5',
    categoria: 'Pruebas y Evidencias',
    jira: 'A10.7 · ADACEEN-96',
    tags: ['evidencias', 'escenarios', 'demo', 'adaceen-96'],
    desc: 'Resultados y salidas reales del tutor al procesar los 5 escenarios pedagógicos.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/evidencias/estabilidad-eventos-simulacion.md'),
    destFolder: '05 - Pruebas y Evidencias',
    destFile: 'estabilidad-eventos-simulacion.md',
    title: 'Evidencia: Estabilidad de Eventos en Simulación',
    categoria: 'Pruebas y Evidencias',
    jira: 'A12.3 · ADACEEN-105',
    tags: ['evidencias', 'estabilidad', 'simulacion', 'adaceen-105'],
    desc: 'Prueba de estrés con 30 estudiantes concurrentes simulando 120 minutos de clase.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/evidencias/latencia-entorno-controlado.md'),
    destFolder: '05 - Pruebas y Evidencias',
    destFile: 'latencia-entorno-controlado.md',
    title: 'Evidencia: Latencia en Entorno Controlado',
    categoria: 'Pruebas y Evidencias',
    jira: 'A12.2 · ADACEEN-104',
    tags: ['evidencias', 'latencia', 'rendimiento', 'adaceen-104'],
    desc: 'Mediciones de tiempo de respuesta (TTFT y tiempo total) en inferencia con Ollama.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/evidencias/ensayo-tecnico-piloto.md'),
    destFolder: '05 - Pruebas y Evidencias',
    destFile: 'ensayo-tecnico-piloto.md',
    title: 'Evidencia: Ensayo Técnico del Piloto',
    categoria: 'Pruebas y Evidencias',
    jira: 'A13.6 · ADACEEN-114',
    tags: ['evidencias', 'ensayo-tecnico', 'dataset', 'adaceen-114'],
    desc: 'Informe exhaustivo del ensayo previo con métricas consolidadas y cálculo de KPIs.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/evidencias/verificacion-cumplimiento-ejemplo.md'),
    destFolder: '05 - Pruebas y Evidencias',
    destFile: 'verificacion-cumplimiento-ejemplo.md',
    title: 'Evidencia: Verificación de Cumplimiento Técnico',
    categoria: 'Pruebas y Evidencias',
    jira: 'A13.4 · ADACEEN-112',
    tags: ['evidencias', 'verificacion', 'cumplimiento'],
    desc: 'Salida de la ejecución de npm run piloto:verificar contra el backend.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/evidencias/cifras-documento.md'),
    destFolder: '05 - Pruebas y Evidencias',
    destFile: 'cifras-documento.md',
    title: 'Cifras Oficiales del Proyecto para el Documento Final',
    categoria: 'Pruebas y Evidencias',
    jira: 'A16.2 · ADACEEN-130, A16.5 · ADACEEN-133',
    tags: ['evidencias', 'cifras', 'estadisticas', 'tesis'],
    desc: 'Métricas maestras de líneas de código, pruebas, eventos, tiempos y costos para la tesis.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/evidencias/ensayo-tecnico/analisis/informe-kpis.md'),
    destFolder: '05 - Pruebas y Evidencias/Ensayo Técnico',
    destFile: 'informe-kpis.md',
    title: 'Informe Detallado de KPIs del Ensayo Técnico',
    categoria: 'Pruebas y Evidencias',
    jira: 'A13.6',
    tags: ['evidencias', 'kpis', 'analisis'],
    desc: 'Cálculo pormenorizado de los indicadores P1-P7, T1-T10 y U1-U3 obtenidos.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/evidencias/ensayo-tecnico/dataset/diccionario-dataset.md'),
    destFolder: '05 - Pruebas y Evidencias/Ensayo Técnico',
    destFile: 'diccionario-dataset.md',
    title: 'Diccionario del Dataset Experimental',
    categoria: 'Pruebas y Evidencias',
    jira: 'A13.6',
    tags: ['evidencias', 'dataset', 'diccionario'],
    desc: 'Descripción de las columnas y variables almacenadas en los CSVs del experimento.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/evidencias/ensayo-tecnico/dataset/limpieza.md'),
    destFolder: '05 - Pruebas y Evidencias/Ensayo Técnico',
    destFile: 'limpieza.md',
    title: 'Reglas de Limpieza y Depuración del Dataset',
    categoria: 'Pruebas y Evidencias',
    jira: 'A13.6',
    tags: ['evidencias', 'dataset', 'limpieza'],
    desc: 'Tratamiento de valores atípicos, sesiones incompletas y normalización de tiempos.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/evidencias/overlay-0.7.14/README.md'),
    destFolder: '05 - Pruebas y Evidencias/Capturas Overlay',
    destFile: 'overlay-0.7.14.md',
    title: 'Capturas del Overlay 0.7.14 (Pestañas y Roles)',
    categoria: 'Pruebas y Evidencias',
    jira: 'A12.8',
    tags: ['evidencias', 'capturas', 'overlay', 'ui'],
    desc: 'Capturas del panel lateral: Administrador, Docente y Estudiante.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/evidencias/overlay-0.7.15/README.md'),
    destFolder: '05 - Pruebas y Evidencias/Capturas Overlay',
    destFile: 'overlay-0.7.15.md',
    title: 'Capturas del Overlay 0.7.15 (Gestión RAG y Quices)',
    categoria: 'Pruebas y Evidencias',
    jira: 'A12.8',
    tags: ['evidencias', 'capturas', 'overlay', 'rag'],
    desc: 'Capturas de lotes RAG y configuración de quices por el docente.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/evidencias/overlay-0.7.16/README.md'),
    destFolder: '05 - Pruebas y Evidencias/Capturas Overlay',
    destFile: 'overlay-0.7.16.md',
    title: 'Capturas del Overlay 0.7.16 (Bitácora del Semestre)',
    categoria: 'Pruebas y Evidencias',
    jira: 'A12.8',
    tags: ['evidencias', 'capturas', 'overlay', 'bitacora'],
    desc: 'Capturas de la importación y sincronización de bitácora semanal.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/evidencias/overlay-0.7.17/README.md'),
    destFolder: '05 - Pruebas y Evidencias/Capturas Overlay',
    destFile: 'overlay-0.7.17.md',
    title: 'Capturas del Overlay 0.7.17 (Agenda y Google Calendar)',
    categoria: 'Pruebas y Evidencias',
    jira: 'A12.8',
    tags: ['evidencias', 'capturas', 'overlay', 'calendar'],
    desc: 'Capturas de la integración de agenda y bloques de estudio.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/evidencias/overlay-0.7.20/README.md'),
    destFolder: '05 - Pruebas y Evidencias/Capturas Overlay',
    destFile: 'overlay-0.7.20.md',
    title: 'Capturas del Overlay 0.7.20 (Código de Dispositivo)',
    categoria: 'Pruebas y Evidencias',
    jira: 'A12.8',
    tags: ['evidencias', 'capturas', 'overlay', 'emparejamiento'],
    desc: 'Capturas de la experiencia de emparejamiento con el túnel VS Code.'
  },

  // 06 - Sustentación de Grado
  {
    src: path.join(REPO_ROOT, 'docs/sustentacion/guion.md'),
    destFolder: '06 - Sustentación de Grado',
    destFile: 'guion.md',
    title: 'Guion de la Sustentación de Grado',
    categoria: 'Sustentación de Grado',
    jira: 'A16.5 · ADACEEN-133',
    tags: ['sustentacion', 'guion', 'defensa', 'adaceen-133'],
    desc: 'Estructura minuto a minuto de la exposición oral (<30 min), demostración y plan B.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/sustentacion/diapositivas.md'),
    destFolder: '06 - Sustentación de Grado',
    destFile: 'diapositivas.md',
    title: 'Contenido y Notas de las Diapositivas',
    categoria: 'Sustentación de Grado',
    jira: 'A16.5 · ADACEEN-133',
    tags: ['sustentacion', 'diapositivas', 'notas-orador'],
    desc: 'Texto de cada diapositiva, figuras referenciadas y notas detalladas para el expositor.'
  },

  // 07 - Seguridad y Accesibilidad
  {
    src: path.join(REPO_ROOT, 'docs/seguridad/permisos-extension.md'),
    destFolder: '07 - Seguridad y Accesibilidad',
    destFile: 'permisos-extension.md',
    title: 'Permisos de la Extensión del Navegador',
    categoria: 'Seguridad y Accesibilidad',
    jira: 'A12.7 · ADACEEN-138',
    tags: ['seguridad', 'permisos', 'manifest', 'privacidad'],
    desc: 'Justificación técnica de cada permiso requerido en manifest.json para Chrome y Firefox.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/seguridad/revision-overlay.md'),
    destFolder: '07 - Seguridad y Accesibilidad',
    destFile: 'revision-overlay.md',
    title: 'Revisión de Seguridad del Overlay',
    categoria: 'Seguridad y Accesibilidad',
    jira: 'A12.8 · ADACEEN-139',
    tags: ['seguridad', 'overlay', 'xss', 'aislamiento'],
    desc: 'Aislamiento Shadow DOM, prevención de XSS y manejo de tokens en almacenamiento local.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/accesibilidad/checklist-wcag-overlay.md'),
    destFolder: '07 - Seguridad y Accesibilidad',
    destFile: 'checklist-wcag-overlay.md',
    title: 'Checklist de Accesibilidad WCAG 2.1 AA del Overlay',
    categoria: 'Seguridad y Accesibilidad',
    jira: 'A12.9 · ADACEEN-140',
    tags: ['accesibilidad', 'wcag', 'a11y', 'overlay'],
    desc: 'Verificación de contrastes de color, navegación por teclado y compatibilidad con lectores de pantalla.'
  },

  // 08 - Operación y Despliegue
  {
    src: path.join(REPO_ROOT, 'docs/operacion/runbook.md'),
    destFolder: '08 - Operación y Despliegue',
    destFile: 'runbook.md',
    title: 'Runbook Operativo de ADACEEN',
    categoria: 'Operación y Despliegue',
    jira: 'A15.7 · ADACEEN-128',
    tags: ['operacion', 'runbook', 'mantenimiento'],
    desc: 'Procedimientos paso a paso para arranque, diagnóstico, reinicio y soporte de incidentes.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/operacion/despliegue.md'),
    destFolder: '08 - Operación y Despliegue',
    destFile: 'despliegue.md',
    title: 'Guía de Despliegue a Producción (Azure + GCP)',
    categoria: 'Operación y Despliegue',
    jira: 'A15.6 · ADACEEN-127, A15.5 · ADACEEN-126',
    tags: ['operacion', 'despliegue', 'azure', 'gcp', 'cloud-shell'],
    desc: 'Comandos exactos en Cloud Shell para revisar, aplicar y verificar la infraestructura.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/operacion/prerrequisitos.md'),
    destFolder: '08 - Operación y Despliegue',
    destFile: 'prerrequisitos.md',
    title: 'Prerrequisitos de Infraestructura y Cuentas',
    categoria: 'Operación y Despliegue',
    jira: 'A15.1 · ADACEEN-122',
    tags: ['operacion', 'prerrequisitos', 'suscripciones'],
    desc: 'Configuración necesaria en Azure, Google Cloud, GitHub App y Google OAuth.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/operacion/monitoreo.md'),
    destFolder: '08 - Operación y Despliegue',
    destFile: 'monitoreo.md',
    title: 'Monitoreo, Métricas en Vivo y Alarmas',
    categoria: 'Operación y Despliegue',
    jira: 'A15.4 · ADACEEN-125',
    tags: ['operacion', 'monitoreo', 'alertas', 'azure-monitor'],
    desc: 'Métricas de saturación de cola, disponibilidad de VM y panel en vivo para el docente.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/operacion/contingencia.md'),
    destFolder: '08 - Operación y Despliegue',
    destFile: 'contingencia.md',
    title: 'Planes de Contingencia y Rollback',
    categoria: 'Operación y Despliegue',
    jira: 'A15.5 · ADACEEN-126',
    tags: ['operacion', 'contingencia', 'rollback', 'failover'],
    desc: 'Estrategias de recuperación ante caída de Azure, agotamiento de GPU o fallos de red.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/operacion/evidencias-despliegue.md'),
    destFolder: '08 - Operación y Despliegue',
    destFile: 'evidencias-despliegue.md',
    title: 'Evidencias del Despliegue en la Nube',
    categoria: 'Operación y Despliegue',
    jira: 'A15.6 · ADACEEN-127',
    tags: ['operacion', 'evidencias', 'cloud'],
    desc: 'Registros de ejecución de scripts de despliegue y respuestas exitosas de endpoints.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/operacion/worker-mac.md'),
    destFolder: '08 - Operación y Despliegue',
    destFile: 'worker-mac.md',
    title: 'Servidores de Inferencia en Mac del Laboratorio',
    categoria: 'Operación y Despliegue',
    jira: 'A15.10 · ADACEEN-151',
    tags: ['operacion', 'mac', 'laboratorio', 'univalle', 'cluster'],
    desc: 'Aprovechamiento de las Mac con Apple Silicon del laboratorio como clúster de inferencia.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/operacion/google-oauth-firefox.md'),
    destFolder: '08 - Operación y Despliegue',
    destFile: 'google-oauth-firefox.md',
    title: 'Google OAuth en Firefox con WebAuthFlow',
    categoria: 'Operación y Despliegue',
    jira: 'A15.9 · ADACEEN-149',
    tags: ['operacion', 'firefox', 'oauth', 'google'],
    desc: 'Implementación del flujo de autenticación alternativo para navegadores Firefox.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/operacion/publicar-extension.md'),
    destFolder: '08 - Operación y Despliegue',
    destFile: 'publicar-extension.md',
    title: 'Publicación de la Extensión (CWS, AMO y Políticas)',
    categoria: 'Operación y Despliegue',
    jira: '—',
    tags: ['operacion', 'publicacion', 'chrome-store', 'firefox-addons'],
    desc: 'Guía para distribución por Chrome Web Store no listada, XPI firmado o políticas de equipo.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/versiones/notas-de-version.md'),
    destFolder: '08 - Operación y Despliegue',
    destFile: 'notas-de-version.md',
    title: 'Notas de Versión y Changelog General',
    categoria: 'Operación y Despliegue',
    jira: 'A15.9 · ADACEEN-149',
    tags: ['versiones', 'changelog', 'releases'],
    desc: 'Historial de versiones de la extensión, backend y worker de inferencia.'
  },

  // 09 - Extensiones
  {
    src: path.join(REPO_ROOT, 'browser-ext-prod/readme.md'),
    destFolder: '09 - Extensiones',
    destFile: 'browser-extension-README.md',
    title: 'Extensión de Navegador (ADACEEN Browser Overlay)',
    categoria: 'Extensiones',
    jira: '—',
    tags: ['extension', 'browser', 'chrome', 'firefox'],
    desc: 'Arquitectura del overlay web inyectado en Campus Virtual y VS Code Web.'
  },
  {
    src: path.join(REPO_ROOT, 'vscode-ext-prod/README.md'),
    destFolder: '09 - Extensiones',
    destFile: 'vscode-extension-README.md',
    title: 'Extensión de VS Code (ADACEEN Companion)',
    categoria: 'Extensiones',
    jira: '—',
    tags: ['extension', 'vscode', 'companion'],
    desc: 'Extensión instalada en el editor para capturar contexto, diagnósticos y sugerencias.'
  },
  {
    src: path.join(REPO_ROOT, 'vscode-ext-prod/CHANGELOG.md'),
    destFolder: '09 - Extensiones',
    destFile: 'vscode-extension-CHANGELOG.md',
    title: 'Changelog de la Extensión de VS Code',
    categoria: 'Extensiones',
    jira: '—',
    tags: ['extension', 'vscode', 'changelog'],
    desc: 'Registro de cambios históricos de la extensión para el editor.'
  },
  {
    src: path.join(REPO_ROOT, 'vscode-ext-prod/README.local-testing.md'),
    destFolder: '09 - Extensiones',
    destFile: 'vscode-extension-local-testing.md',
    title: 'Pruebas Locales de la Extensión de VS Code',
    categoria: 'Extensiones',
    jira: '—',
    tags: ['extension', 'vscode', 'testing'],
    desc: 'Instrucciones para depurar la extensión de VS Code en entorno local.'
  },
  {
    src: path.join(REPO_ROOT, 'vscode-ext-prod/vsc-extension-quickstart.md'),
    destFolder: '09 - Extensiones',
    destFile: 'vscode-extension-quickstart.md',
    title: 'Quickstart de Desarrollo de la Extensión de VS Code',
    categoria: 'Extensiones',
    jira: '—',
    tags: ['extension', 'vscode', 'quickstart'],
    desc: 'Guía rápida de compilación y empaquetado VSIX.'
  },
  {
    src: path.join(REPO_ROOT, 'vscode-ext-prod/tesis/README.md'),
    destFolder: '09 - Extensiones',
    destFile: 'vscode-extension-tesis-README.md',
    title: 'Módulo Tesis en la Extensión de VS Code',
    categoria: 'Extensiones',
    jira: '—',
    tags: ['extension', 'vscode', 'tesis'],
    desc: 'Estructura Node.js + TypeScript estricto del proyecto de tesis.'
  },

  // 10 - Informes y Decisiones
  {
    src: path.join(INFORMES_ROOT, 'Comandos - alzar el tunel y probar.md'),
    destFolder: '10 - Informes y Decisiones',
    destFile: 'Comandos - alzar el tunel y probar.md',
    title: 'Comandos Rápidos: Alzar el Túnel y Probar',
    categoria: 'Informes y Decisiones',
    jira: '—',
    tags: ['operacion', 'comandos', 'tunel', 'guia-rapida'],
    desc: 'Guía paso a paso para la rutina diaria de encendido, prueba y apagado de la VM y GPU.'
  },
  {
    src: path.join(INFORMES_ROOT, 'decisiones-entorno-estudiantes.md'),
    destFolder: '10 - Informes y Decisiones',
    destFile: 'decisiones-entorno-estudiantes.md',
    title: 'Decisiones del Entorno de Estudiantes: Descartados y Solución',
    categoria: 'Informes y Decisiones',
    jira: '—',
    tags: ['decisiones', 'entorno', 'codespaces', 'dev-tunnels'],
    desc: 'Análisis de alternativas evaluadas (Codespaces, OpenVSCode, forks) y justificación de la solución.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/contexto-modularizacion.md'),
    destFolder: '10 - Informes y Decisiones',
    destFile: 'contexto-modularizacion.md',
    title: 'Contexto de la Modularización del Backend',
    categoria: 'Informes y Decisiones',
    jira: '—',
    tags: ['arquitectura', 'refactor', 'modularizacion'],
    desc: 'Historia del refactor para dividir AppDatabase y controladores en facades modulares.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/entregables/README.md'),
    destFolder: '10 - Informes y Decisiones',
    destFile: 'entregables-word.md',
    title: 'Entregables en Formato Word (Pandoc)',
    categoria: 'Informes y Decisiones',
    jira: '—',
    tags: ['entregables', 'word', 'pandoc', 'director'],
    desc: 'Relación de documentos exportados a .docx para el director y el docente.'
  },

  // 11 - Guías y Desarrollo Local
  {
    src: path.join(REPO_ROOT, 'docs/guia-instalacion-uso.md'),
    destFolder: '11 - Guías y Desarrollo Local',
    destFile: 'guia-instalacion-uso.md',
    title: 'Guía de Instalación y Uso para Estudiantes y Docentes',
    categoria: 'Guías y Desarrollo Local',
    jira: 'A16.8 · ADACEEN-150',
    tags: ['guia', 'instalacion', 'manual-usuario', 'adaceen-150'],
    desc: 'Manual ilustrado paso a paso para instalar la extensión e interactuar con el tutor.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/local-development.md'),
    destFolder: '11 - Guías y Desarrollo Local',
    destFile: 'local-development.md',
    title: 'Guía de Desarrollo Local',
    categoria: 'Guías y Desarrollo Local',
    jira: '—',
    tags: ['desarrollo', 'local', 'entorno', 'setup'],
    desc: 'Instrucciones para levantar el backend, PostgreSQL y workers en la máquina de desarrollo.'
  },
  {
    src: path.join(REPO_ROOT, 'docs/google-login-postgres.md'),
    destFolder: '11 - Guías y Desarrollo Local',
    destFile: 'google-login-postgres.md',
    title: 'Autenticación con Google y Base de Datos PostgreSQL',
    categoria: 'Guías y Desarrollo Local',
    jira: '—',
    tags: ['autenticacion', 'google', 'postgres', 'seguridad'],
    desc: 'Configuración de credenciales de Google OAuth y esquema relacional en PostgreSQL.'
  },
  {
    src: path.join(REPO_ROOT, 'AGENTS.md'),
    destFolder: '11 - Guías y Desarrollo Local',
    destFile: 'AGENTS.md',
    title: 'Guía de Desarrollo con Agentes de IA en el Repositorio',
    categoria: 'Guías y Desarrollo Local',
    jira: '—',
    tags: ['agentes', 'normas', 'git', 'desarrollo'],
    desc: 'Reglas y pautas para agentes de IA que trabajan en el código de ADACEEN.'
  },

  // Índice Maestro de Documentación del Repositorio
  {
    src: path.join(REPO_ROOT, 'docs/README.md'),
    destFolder: '',
    destFile: 'ADACEEN - Índice Técnico (docs-README).md',
    title: 'Documentación Técnica de ADACEEN (Índice Original)',
    categoria: 'Índice Maestro',
    jira: 'Espacio ADACEEN',
    tags: ['indice', 'jira', 'maestro'],
    desc: 'El índice completo original generado con cada actividad de Jira respaldando cada documento.'
  }
];

// Helper to ensure directory exists
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Helper to copy directory recursively
function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) return;
  ensureDirSync(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Generate banner for notes
function createNoteHeader(doc, folderMocName) {
  const tagsStr = doc.tags.map(t => `  - ${t}`).join('\n');
  const frontmatter = `---
title: "${doc.title.replace(/"/g, '\\"')}"
categoria: "${doc.categoria}"
jira: "${doc.jira}"
tags:
${tagsStr}
---

`;

  const banner = `> [!info] **ADACEEN** · [[00 - 🏠 Dashboard ADACEEN|🏠 Dashboard General]] ${folderMocName ? `· [[${folderMocName}|📁 ${doc.categoria}]]` : ''}
> **Actividad Jira:** \`${doc.jira}\` | **Categoría:** *${doc.categoria}*
> **Propósito:** ${doc.desc}

---

`;

  return frontmatter + banner;
}

// Main execution
console.log('🚀 Iniciando organización de la documentación en Obsidian Vault...');

ensureDirSync(ADACEEN_DIR);
const recursosDir = path.join(ADACEEN_DIR, '_recursos');
ensureDirSync(recursosDir);

// 1. Copy Assets & Media
console.log('📦 Copiando recursos multimedia (SVGs, PNGs, CSVs)...');

// Diagrama arquitectura SVG
const rutaDatosSvgSrc = path.join(REPO_ROOT, 'docs/arquitectura/ruta-de-datos.svg');
if (fs.existsSync(rutaDatosSvgSrc)) {
  fs.copyFileSync(rutaDatosSvgSrc, path.join(recursosDir, 'ruta-de-datos.svg'));
  const destArch = path.join(ADACEEN_DIR, '01 - Arquitectura y Diseño');
  ensureDirSync(destArch);
  fs.copyFileSync(rutaDatosSvgSrc, path.join(destArch, 'ruta-de-datos.svg'));
}

// Copiar evidencias y gráficas
const ensayoSrc = path.join(REPO_ROOT, 'docs/evidencias/ensayo-tecnico');
const ensayoDest = path.join(ADACEEN_DIR, '05 - Pruebas y Evidencias/Ensayo Técnico');
if (fs.existsSync(ensayoSrc)) {
  copyDirSync(ensayoSrc, ensayoDest);
}

// Copiar capturas overlay
const evidenciasRoot = path.join(REPO_ROOT, 'docs/evidencias');
const overlayFolders = ['overlay-0.7.14', 'overlay-0.7.15', 'overlay-0.7.16', 'overlay-0.7.17', 'overlay-0.7.20'];
for (const ov of overlayFolders) {
  const ovSrc = path.join(evidenciasRoot, ov);
  const ovDest = path.join(ADACEEN_DIR, `05 - Pruebas y Evidencias/Capturas Overlay/${ov}`);
  if (fs.existsSync(ovSrc)) {
    copyDirSync(ovSrc, ovDest);
  }
}

// 2. Process and write each Markdown document
console.log('📝 Copiando y enriqueciendo notas Markdown...');

const folderMocMap = {
  '01 - Arquitectura y Diseño': '01 - 📐 Índice de Arquitectura',
  '02 - Tutor Pedagógico': '02 - 🧑‍🏫 Índice de Tutor Pedagógico',
  '03 - Piloto Experimental y Métricas': '03 - 🧪 Índice de Piloto y Métricas',
  '04 - Telemetría y Datos': '04 - 📊 Índice de Telemetría y Datos',
  '05 - Pruebas y Evidencias': '05 - 🔬 Índice de Pruebas y Evidencias',
  '05 - Pruebas y Evidencias/Ensayo Técnico': '05 - 🔬 Índice de Pruebas y Evidencias',
  '05 - Pruebas y Evidencias/Capturas Overlay': '05 - 🔬 Índice de Pruebas y Evidencias',
  '06 - Sustentación de Grado': '06 - 🎓 Índice de Sustentación',
  '07 - Seguridad y Accesibilidad': '07 - 🔒 Índice de Seguridad y Accesibilidad',
  '08 - Operación y Despliegue': '08 - 🚀 Índice de Operación y Despliegue',
  '09 - Extensiones': '09 - 🧩 Índice de Extensiones',
  '10 - Informes y Decisiones': '10 - 📝 Índice de Informes y Decisiones',
  '11 - Guías y Desarrollo Local': '11 - 🛠️ Índice de Guías y Desarrollo Local'
};

let processedCount = 0;

for (const doc of DOCUMENTS) {
  if (!fs.existsSync(doc.src)) {
    console.warn(`⚠️ Archivo origen no encontrado: ${doc.src}`);
    continue;
  }

  const targetDir = doc.destFolder ? path.join(ADACEEN_DIR, doc.destFolder) : ADACEEN_DIR;
  ensureDirSync(targetDir);
  const targetPath = path.join(targetDir, doc.destFile);

  const rawContent = fs.readFileSync(doc.src, 'utf-8');

  // Check if it already has frontmatter
  let cleanContent = rawContent;
  if (rawContent.startsWith('---')) {
    const endFm = rawContent.indexOf('---', 3);
    if (endFm !== -1) {
      cleanContent = rawContent.slice(endFm + 3).trimStart();
    }
  }

  const mocName = folderMocMap[doc.destFolder] || null;
  const enriched = createNoteHeader(doc, mocName) + cleanContent;

  fs.writeFileSync(targetPath, enriched, 'utf-8');
  processedCount++;
}

console.log(`✅ Procesados ${processedCount} documentos Markdown.`);

// 3. Generate Folder MOCs (Maps of Content)
console.log('🗺️ Generando Índices por Carpeta (MOCs)...');

const categories = [
  {
    folder: '01 - Arquitectura y Diseño',
    mocFile: '01 - 📐 Índice de Arquitectura.md',
    title: 'Arquitectura y Diseño del Sistema',
    icon: '📐',
    desc: 'Arquitectura desacoplada de ADACEEN: motor de inferencia, Service Bus en Azure, workers GPU, Dev Tunnels y contratos API.'
  },
  {
    folder: '02 - Tutor Pedagógico',
    mocFile: '02 - 🧑‍🏫 Índice de Tutor Pedagógico.md',
    title: 'Tutor Pedagógico y Reglas de Intervención',
    icon: '🧑‍🏫',
    desc: 'Diseño pedagógico: escenarios S1–S5, plantillas de intervención socrática, matriz RAG y banco de preguntas de autoevaluación.'
  },
  {
    folder: '03 - Piloto Experimental y Métricas',
    mocFile: '03 - 🧪 Índice de Piloto y Métricas.md',
    title: 'Piloto Experimental y Catálogo de KPIs',
    icon: '🧪',
    desc: 'Protocolo cruzado AB/BA, instrumentos de medición (SUS, Likert), consentimiento informado, checklist y catálogo de 20 KPIs.'
  },
  {
    folder: '04 - Telemetría y Datos',
    mocFile: '04 - 📊 Índice de Telemetría y Datos.md',
    title: 'Telemetría y Gobernanza de Datos',
    icon: '📊',
    desc: 'Esquema de eventos telemétricos, trazabilidad de decisiones del tutor y seudonimización conforme a normativas de privacidad.'
  },
  {
    folder: '05 - Pruebas y Evidencias',
    mocFile: '05 - 🔬 Índice de Pruebas y Evidencias.md',
    title: 'Pruebas, Ensayos Técnicos y Evidencias',
    icon: '🔬',
    desc: 'Resultados del ensayo técnico del piloto, pruebas de carga con simulación, latencia en entorno controlado y capturas de la UI.'
  },
  {
    folder: '06 - Sustentación de Grado',
    mocFile: '06 - 🎓 Índice de Sustentación.md',
    title: 'Sustentación del Proyecto de Grado',
    icon: '🎓',
    desc: 'Guion cronometrado de defensa oral (<30 min), diapositivas con notas de orador y cifras consolidadas del proyecto.'
  },
  {
    folder: '07 - Seguridad y Accesibilidad',
    mocFile: '07 - 🔒 Índice de Seguridad y Accesibilidad.md',
    title: 'Seguridad, Privacidad y Accesibilidad',
    icon: '🔒',
    desc: 'Permisos mínimos en extensiones, revisión de aislamiento de overlay y verificación WCAG 2.1 AA de accesibilidad.'
  },
  {
    folder: '08 - Operación y Despliegue',
    mocFile: '08 - 🚀 Índice de Operación y Despliegue.md',
    title: 'Operación, Despliegue y Runbooks',
    icon: '🚀',
    desc: 'Procedimientos en Cloud Shell, contingencias, monitoreo de colas, publicación de extensiones y aprovechamiento de Macs.'
  },
  {
    folder: '09 - Extensiones',
    mocFile: '09 - 🧩 Índice de Extensiones.md',
    title: 'Extensiones: Navegador y VS Code',
    icon: '🧩',
    desc: 'Documentación técnica de la extensión web (overlay) y la extensión compañera de VS Code.'
  },
  {
    folder: '10 - Informes y Decisiones',
    mocFile: '10 - 📝 Índice de Informes y Decisiones.md',
    title: 'Informes y Registro de Decisiones',
    icon: '📝',
    desc: 'Comandos rápidos para alzar el túnel, registro de alternativas evaluadas/descartadas y exportación a Word.'
  },
  {
    folder: '11 - Guías y Desarrollo Local',
    mocFile: '11 - 🛠️ Índice de Guías y Desarrollo Local.md',
    title: 'Guías de Instalación y Desarrollo Local',
    icon: '🛠️',
    desc: 'Manual de usuario para estudiantes/docentes, guías de arranque local con PostgreSQL y directrices para agentes de IA.'
  }
];

for (const cat of categories) {
  const catDocs = DOCUMENTS.filter(d => d.destFolder && d.destFolder.startsWith(cat.folder));
  
  let docTable = '| Nota | Jira | Propósito |\n|---|---|---|\n';
  for (const cd of catDocs) {
    const noteName = cd.destFile.replace(/\.md$/, '');
    docTable += `| [[${noteName}\\|${cd.title}]] | \`${cd.jira}\` | ${cd.desc} |\n`;
  }

  const mocContent = `---
title: "${cat.title}"
categoria: "MOC"
tags:
  - moc
  - indice
  - adaceen
---

# ${cat.icon} ${cat.title}

> [!abstract] **Visión General**
> ${cat.desc}
> 
> **Navegación:** [[00 - 🏠 Dashboard ADACEEN|⬅️ Volver al Dashboard General]]

---

## 📄 Documentos en esta sección

${docTable}

---

## 🔗 Conexiones Rápidas
- **Dashboard Principal:** [[00 - 🏠 Dashboard ADACEEN]]
- **Índice Técnico Original:** [[ADACEEN - Índice Técnico (docs-README)]]
- **Sustentación:** [[guion|Guion de Sustentación]] · [[diapositivas|Diapositivas]] · [[cifras-documento|Cifras Oficiales]]
`;

  const mocPath = path.join(ADACEEN_DIR, cat.folder, cat.mocFile);
  fs.writeFileSync(mocPath, mocContent, 'utf-8');
}

// 4. Generate Master Dashboard (MOC)
console.log('🌟 Generando 00 - 🏠 Dashboard ADACEEN.md...');

let allDocsTable = '| # | Documento | Categoría | Jira | Resumen |\n|---|---|---|---|---|\n';
DOCUMENTS.forEach((doc, idx) => {
  const noteName = doc.destFile.replace(/\.md$/, '');
  allDocsTable += `| ${idx + 1} | [[${noteName}\\|${doc.title}]] | *${doc.categoria}* | \`${doc.jira}\` | ${doc.desc} |\n`;
});

const dashboardContent = `---
title: "Dashboard General de ADACEEN"
categoria: "Dashboard"
tags:
  - dashboard
  - moc
  - adaceen
  - tesis
  - univalle
---

# 🎓 ADACEEN · Centro de Documentación y Proyecto de Grado
### Asistente Docente Adaptativo con IA para Fundamentos de Programación Orientada a Objetos
**Universidad del Valle · Escuela de Ingeniería de Sistemas y Computación · Trabajo de Grado II**

> [!tip] **Bienvenido a tu Bóveda de Obsidian**
> Toda la investigación, especificaciones técnicas, protocolos experimentales, métricas y evidencias producidas durante el proyecto se encuentran centralizadas y organizadas aquí.
> - **Navegación:** Haz clic en cualquier enlace de la tabla o usa la **Vista Gráfica** (\`Ctrl + G\`) para explorar cómo se conectan los conceptos.
> - **Búsqueda Rápida:** Pulsa \`Ctrl + O\` para abrir cualquier documento al instante.

---

## ⚡ Accesos Rápidos por Escenario de Uso

> [!example] 🎓 **Para la Sustentación de Grado y Jurados**
> - [[guion|🎙️ Guion de la Sustentación (<30 min)]] · [[diapositivas|🖼️ Contenido de Diapositivas y Notas]]
> - [[cifras-documento|📊 Cifras Oficiales del Proyecto (Líneas, Pruebas, Tiempos, Costos)]]
> - [[informe-kpis|📈 Informe de Cumplimiento de KPIs]] · [[validacion-director|📑 Paquete de Validación del Director]]

> [!success] 🧪 **Para el Piloto Experimental y Clases**
> - [[protocolo|📋 Protocolo Experimental (Diseño AB/BA)]] · [[instrumentos|📝 Cuestionarios SUS y Likert]]
> - [[guia-instalacion-uso|📖 Guía de Instalación para Estudiantes y Docente]]
> - [[checklist-cumplimiento|✅ Checklist Previo al Piloto]] · [[plan-de-soporte|🛟 Plan de Soporte en Vivo]]

> [!danger] 🚀 **Para la Operación en la Nube y Túneles**
> - [[Comandos - alzar el tunel y probar|⚡ Comandos Diarios: Alzar el Túnel y Probar]]
> - [[despliegue|☁️ Guía de Despliegue en Producción (Azure + GCP)]]
> - [[runbook|🛠️ Runbook de Operación y Diagnóstico]] · [[monitoreo|📡 Monitoreo y Alarmas]]

> [!info] 📐 **Para Comprender la Arquitectura y el Tutor**
> - [[adr-001-motor-y-arquitectura|ADR-001: Motor y Decisión de Arquitectura]] · [[ruta-de-datos|Ruta de Datos (17 tramos y privacidad)]]
> - [[service-bus-ollama-worker|Worker GPU con Azure Service Bus y Ollama]]
> - [[escenarios|Escenarios Pedagógicos S1–S5]] · [[plantillas-intervencion|Guardarraíles y Prompts]]

---

## 🗂️ Módulos de Conocimiento (Áreas del Proyecto)

| Módulo | Sección | Documentos Clave |
|---|---|---|
| **01** | [[01 - 📐 Índice de Arquitectura\\|📐 Arquitectura y Diseño]] | [[adr-001-motor-y-arquitectura\\|ADR-001]], [[ruta-de-datos\\|Ruta de Datos]], [[contrato-api\\|Contrato API]], [[service-bus-ollama-worker\\|Worker GPU]] |
| **02** | [[02 - 🧑‍🏫 Índice de Tutor Pedagógico\\|🧑‍🏫 Tutor Pedagógico]] | [[escenarios\\|Escenarios S1-S5]], [[plantillas-intervencion\\|Guardarraíles]], [[banco-quiz\\|Banco de Quices]] |
| **03** | [[03 - 🧪 Índice de Piloto y Métricas\\|🧪 Piloto y Métricas]] | [[protocolo\\|Protocolo AB/BA]], [[catalogo-kpis\\|Catálogo de 20 KPIs]], [[instrumentos\\|Instrumentos SUS]], [[consentimiento\\|Consentimiento]] |
| **04** | [[04 - 📊 Índice de Telemetría y Datos\\|📊 Telemetría y Datos]] | [[diccionario-eventos\\|Diccionario de Eventos]], [[trazabilidad-decisiones\\|Trazabilidad de Decisiones]] |
| **05** | [[05 - 🔬 Índice de Pruebas y Evidencias\\|🔬 Pruebas y Evidencias]] | [[ensayo-tecnico-piloto\\|Ensayo Técnico]], [[cifras-documento\\|Cifras]], [[latencia-entorno-controlado\\|Latencia]], [[overlay-0.7.14\\|Capturas Overlay]] |
| **06** | [[06 - 🎓 Índice de Sustentación\\|🎓 Sustentación de Grado]] | [[guion\\|Guion Oficial]], [[diapositivas\\|Diapositivas y Notas]] |
| **07** | [[07 - 🔒 Índice de Seguridad y Accesibilidad\\|🔒 Seguridad y Accesibilidad]] | [[permisos-extension\\|Permisos]], [[revision-overlay\\|Seguridad Overlay]], [[checklist-wcag-overlay\\|WCAG 2.1 AA]] |
| **08** | [[08 - 🚀 Índice de Operación y Despliegue\\|🚀 Operación y Despliegue]] | [[despliegue\\|Despliegue Azure/GCP]], [[runbook\\|Runbook]], [[worker-mac\\|Macs Laboratorio]] |
| **09** | [[09 - 🧩 Índice de Extensiones\\|🧩 Extensiones]] | [[browser-extension-README\\|Overlay Navegador]], [[vscode-extension-README\\|Extensión VS Code]] |
| **10** | [[10 - 📝 Índice de Informes y Decisiones\\|📝 Informes y Decisiones]] | [[Comandos - alzar el tunel y probar\\|Comandos de Rutina]], [[decisiones-entorno-estudiantes\\|Decisiones Entorno]] |
| **11** | [[11 - 🛠️ Índice de Guías y Desarrollo Local\\|🛠️ Guías y Desarrollo Local]] | [[guia-instalacion-uso\\|Guía de Instalación]], [[local-development\\|Desarrollo Local]], [[AGENTS\\|Reglas para Agentes]] |

---

## 📋 Catálogo Completo de Documentación

${allDocsTable}

---

## 🏷️ Nube de Etiquetas
\`#adaceen\` \`#arquitectura\` \`#tutor\` \`#pedagogia\` \`#piloto\` \`#kpi\` \`#telemetria\` \`#seguridad\` \`#operacion\` \`#sustentacion\` \`#extension\` \`#vscode\`
`;

fs.writeFileSync(path.join(VAULT_ROOT, '00 - 🏠 Dashboard ADACEEN.md'), dashboardContent, 'utf-8');

// 5. Update Bienvenido.md to point to the Dashboard
const bienvenidoContent = `---
title: "Bienvenido a ADACEEN en Obsidian"
tags:
  - bienvenida
  - adaceen
---

# 👋 Bienvenido a tu Bóveda de ADACEEN en Obsidian

Toda la documentación técnica, pedagógica, operativa y de sustentación de tu trabajo de grado ha sido organizada y conectada mediante enlaces bidireccionales.

> [!important] 🚀 **Punto de Partida Recomendado**
> Abre el panel central: **[[00 - 🏠 Dashboard ADACEEN|🏠 Ir al Dashboard General de ADACEEN]]**

---

### 🗺️ Sugerencias para aprovechar Obsidian:
1. **Vista Gráfica:** Presiona \`Ctrl + G\` para ver el mapa de relaciones entre componentes, arquitectura, pruebas y sustentación.
2. **Buscador Rápido:** Presiona \`Ctrl + O\` para abrir cualquier nota por su título o palabra clave.
3. **Explorador de Archivos:** A la izquierda encontrarás la carpeta **\`ADACEEN/\`** con 11 secciones numeradas y ordenadas por temática.
`;

fs.writeFileSync(path.join(VAULT_ROOT, 'Bienvenido.md'), bienvenidoContent, 'utf-8');

console.log('🎉 ¡Organización completada exitosamente en Obsidian Vault!');
