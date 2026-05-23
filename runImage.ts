// src/runImage.ts
import fs from "node:fs/promises";
import path from "node:path";

export async function runImage(imagePath: string, prompt: string) {
  const abs = path.resolve(imagePath);
  const b64 = (await fs.readFile(abs)).toString("base64"); // base64 puro

  const model = process.env.MODEL_VISION || "qwen2.5vl:7b-gpu";
  const base  = process.env.OLLAMA_URL   || "http://127.0.0.1:11434";

  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      // 👇 desactiva streaming para que devuelva un JSON único
      stream: false,
      messages: [
        {
          role: "user",
          // 👇 content es STRING (no array)
          content: prompt || "Describe la imagen en 5 puntos y da 3 recomendaciones.",
          // 👇 imágenes: array de base64 PURO (sin data:image/...;base64,)
          images: [b64],
        }
      ],
      options: { temperature: 0.2, num_ctx: 1024, num_batch: 48 }
    }),
  });

  if (!res.ok) throw new Error(`Vision HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json(); // ahora sí es JSON
  return String(data?.message?.content ?? data?.response ?? "");
}
