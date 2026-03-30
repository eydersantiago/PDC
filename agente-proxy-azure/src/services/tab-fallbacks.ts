function normalizeNum(value: string) {
  return Number.parseFloat(String(value || "").replace(",", "."));
}

function extractGradeRows(text: string) {
  const lines = String(text || "").split(/\r?\n/);
  const rows: Array<{ code: string; grade: number }> = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const match = line.match(/^(\d{5,})\s+([0-5](?:[.,]\d+)?)$/);
    if (!match) continue;

    const grade = normalizeNum(match[2]);
    if (!Number.isFinite(grade) || grade < 0 || grade > 5) continue;

    rows.push({ code: match[1], grade });
  }

  return rows;
}

function parseThresholdFromQuestion(question: string) {
  const normalized = String(question || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const gte = normalized.match(
    /(?:igual\s*(?:o|\/)?\s*superior|superior\s*(?:o|\/)?\s*igual|mayor\s*(?:o\s*)?igual|mayor\s*igual|al\s*menos|>=)\s*(?:a\s*)?([0-9]+(?:[.,][0-9]+)?)/i,
  );
  if (gte) return { op: "gte" as const, threshold: normalizeNum(gte[1]) };

  const gt = normalized.match(/(?:superior(?:es)?|mayor(?:es)?|por encima|mas de|>)\s*(?:a\s*)?([0-9]+(?:[.,][0-9]+)?)/i);
  if (gt) return { op: "gt" as const, threshold: normalizeNum(gt[1]) };

  return null;
}

function asksForFullPdfText(question: string) {
  const normalized = String(question || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const asksAllText =
    /todo el contenido|contenido completo|texto completo|transcrib|extrae todo|dame todo el texto/.test(normalized);
  const asksDocument = /pdf|archivo|documento|notas taller 2/.test(normalized);
  return asksAllText && asksDocument;
}

function extractLinkedTextBlocks(tabContent: string) {
  const text = String(tabContent || "");
  const regex = /Contenido visible del enlace:\n([\s\S]*?)(?=\n\nEnlace consultado \d+:|\n\nContenido visible \(pestana actual\):|$)/g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null = null;

  while ((match = regex.exec(text)) !== null) {
    const block = (match[1] || "").trim();
    if (!block || /\(sin texto visible\)/i.test(block)) continue;
    blocks.push(block);
  }

  return blocks;
}

function extractCandidateGradeLinks(tabContent: string, limit = 3) {
  const lines = String(tabContent || "").split(/\r?\n/);
  const output: string[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const urlMatch = line.match(/https?:\/\/\S+/i);
    if (!urlMatch) continue;

    const url = urlMatch[0].trim();
    const lower = line.toLowerCase();
    if (!/(taller|nota|calific|grade|report|pdf)/.test(lower)) continue;
    if (seen.has(url)) continue;

    seen.add(url);
    output.push(url);
    if (output.length >= limit) break;
  }

  return output;
}

export function buildMissingPdfTextAnswer(params: { question: string; tabContent: string }) {
  if (!asksForFullPdfText(params.question)) return null;

  const linkedTextBlocks = extractLinkedTextBlocks(params.tabContent);
  const mergedLinkedText = linkedTextBlocks.join("\n").trim();
  if (mergedLinkedText.length >= 350) return null;

  const links = extractCandidateGradeLinks(params.tabContent, 4);
  const lines = [
    "1) Resumen",
    "- Pediste el contenido completo del PDF, pero no se detecto texto util del documento en el contexto recibido.",
    "- Responder con texto inventado seria incorrecto.",
    "",
    "2) Sugerencias",
    "- Abre el PDF en una pestana normal y vuelve a consultar para capturar su texto.",
    "- Si quieres exactitud inmediata, pega aqui el texto del PDF y te lo devuelvo limpio/completo.",
    "- Verifica que la extension tenga permisos para `campusvirtual.univalle.edu.co` y recargala.",
    "",
    "3) Dudas o riesgos",
    "- Si Moodle muestra un visor sin texto seleccionable, la extension puede no extraer contenido.",
    "- Si el archivo tiene imagenes escaneadas, se requiere OCR para recuperar todo el texto.",
  ];

  if (links.length > 0) {
    lines.push("", "Enlaces detectados:");
    for (const link of links) {
      lines.push(`- ${link}`);
    }
  }

  return lines.join("\n");
}

export function buildDeterministicGradeAnswer(params: { question: string; tabContent: string }) {
  const question = String(params.question || "").trim();
  const thresholdSpec = parseThresholdFromQuestion(question);
  if (!thresholdSpec) return null;

  const rows = extractGradeRows(params.tabContent);
  if (rows.length < 5) {
    const links = extractCandidateGradeLinks(params.tabContent, 3);
    const needsGrades = /(nota|calific|taller|estudiante|pdf)/i.test(question);
    if (!needsGrades) return null;

    const lines = [
      "1) Resumen",
      "- La pregunta requiere contar notas por umbral, pero en el contenido recibido no aparecen filas de calificaciones (codigo + nota).",
      "- Sin ese listado no puedo calcular una cantidad confiable.",
      "",
      "2) Sugerencias",
      "- Abre el PDF de \"Notas Taller 2\" y vuelve a consultar cuando se vea el texto de notas en pantalla.",
      "- Si prefieres, pega aqui el bloque de notas (codigo y valor) y te doy el conteo exacto.",
      "- Confirma si el criterio es \"> 3.0\" o \">= 3.0\".",
      "",
      "3) Dudas o riesgos",
      "- Contar sin ver el listado real produce respuestas incorrectas.",
      "- Si el PDF tiene varias paginas, hay riesgo de conteo parcial si solo llega una parte del contenido.",
    ];

    if (links.length > 0) {
      lines.push("", "Enlaces detectados (posibles fuentes):");
      for (const link of links) {
        lines.push(`- ${link}`);
      }
    }

    return lines.join("\n");
  }

  const comparator = thresholdSpec.op === "gte"
    ? (value: number) => value >= thresholdSpec.threshold
    : (value: number) => value > thresholdSpec.threshold;
  const symbol = thresholdSpec.op === "gte" ? ">=" : ">";
  const count = rows.filter((row) => comparator(row.grade)).length;

  return [
    "1) Resumen",
    `- Se detectaron ${rows.length} calificaciones en el contenido analizado.`,
    `- Estudiantes con nota ${symbol} ${thresholdSpec.threshold.toFixed(1)}: ${count}.`,
    "",
    "2) Sugerencias",
    "- Validar que el texto corresponde exactamente al archivo solicitado (por ejemplo: \"Notas Taller 2\").",
    "- Si quieres, puedo listar los codigos que cumplen la condicion.",
    "- Para auditoria, conserva una copia del texto fuente junto al conteo.",
    "",
    "3) Dudas o riesgos",
    "- Si el PDF tiene mas paginas o filas no capturadas, el conteo podria quedar incompleto.",
    "- Si hay formatos de nota distintos (coma/punto), conviene normalizar antes del calculo.",
  ].join("\n");
}
