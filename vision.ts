import fs from "node:fs/promises";
import path from "node:path";

type VisionJSON = { resumen: string[]; recomendaciones: string[] };

const ollama = process.env.OLLAMA_URL   || "http://127.0.0.1:11434";
const model  = process.env.MODEL_VISION || "qwen2.5vl:7b-gpu";

async function ollamaChat(messages: any[], fmt: "text" | "json" = "text") {
  const r = await fetch(`${ollama}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      format: fmt === "json" ? "json" : undefined,
      options: { temperature: 0.0, num_ctx: 1024, top_k: 20, top_p: 0.9 },
    }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text().catch(()=> "")}`);
  const j = await r.json();
  return String(j?.message?.content ?? j?.response ?? "");
}

function looksBad(s: string) {
  // heurística: números sueltos, arrays, “...5 points...”, palabras repetidas
  if (/\[\s*\d+(\.\d+)?\s*(,\s*\d+(\.\d+)?\s*)+\]/.test(s)) return true;
  if (/(\.\.\.|5 points|\[0\.\d+.*\])/.test(s)) return true;
  if (/(Café\s*,\s*){2,}|(Erosion\s*,\s*){2,}/i.test(s)) return true;
  return false;
}

export async function runVisionAgent(imagePath: string, userPrompt: string): Promise<string> {
  const imgB64 = (await fs.readFile(path.resolve(imagePath))).toString("base64");

  const systemA = [
    "Eres un asistente de visión. SOLO devuelves texto en español, en párrafos normales.",
    "Prohibido devolver coordenadas, cajas, puntuaciones, arrays numéricos o placeholders.",
    "Describe con detalle lo visible en la imagen y cualquier texto legible (OCR).",
  ].join(" ");

  const promptA =
    (userPrompt?.trim() || "Describe la imagen y el texto que se vea (OCR). Devuelve solo texto en español.");

  // Etapa A: descripción limpia (texto)
  let desc = await ollamaChat(
    [
      { role: "system", content: systemA },
      { role: "user",   content: promptA, images: [imgB64] },
    ],
    "text"
  );

  // Si huele mal, reintento con instrucciones aún más duras
  if (looksBad(desc)) {
    const systemA2 = systemA + " Es obligatorio responder en prosa; está prohibido responder con listas numéricas.";
    desc = await ollamaChat(
      [
        { role: "system", content: systemA2 },
        { role: "user",   content: promptA, images: [imgB64] },
      ],
      "text"
    );
  }

  // Etapa B: convertir a JSON estructurado
  const systemB = [
    'Convierte la siguiente descripción a JSON ESTRICTO con esta forma:',
    '{"resumen":[5 ítems breves], "recomendaciones":[3 ítems breves]}.',
    "No agregues campos extra. Responde SOLO el JSON.",
  ].join(" ");

  let jsonText = await ollamaChat(
    [
      { role: "system", content: systemB },
      { role: "user",   content: desc },
    ],
    "json"
  );

  // Validación de JSON
  try {
    const obj = JSON.parse(jsonText) as VisionJSON;
    // sanity check
    if (!Array.isArray(obj.resumen) || obj.resumen.length === 0) throw new Error("bad");
    if (!Array.isArray(obj.recomendaciones) || obj.recomendaciones.length === 0) throw new Error("bad");
    return JSON.stringify(obj);
  } catch {
    // Fallback mínimo si el modelo se sale del molde
    return JSON.stringify({
      resumen: [desc.slice(0, 200)],
      recomendaciones: [
        "Vuelve a subir la imagen con mejor enfoque/iluminación.",
        "Evita recortes excesivos o baja resolución.",
        "Si necesitas OCR, usa capturas con texto grande y claro.",
      ],
    } satisfies VisionJSON);
  }
}
