import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { buildOllamaChatBody, readNdjsonLines, runText } from "../../../runText.js";
import { decideJobFailure } from "../../../src/services/queue/queue-worker-policy.js";
import { resolveTextGeneration } from "../../../src/services/tutor/text-generation.js";
import { withEnv } from "./helpers.js";

// Respuesta del tutor en vivo (01-11-2026): runText pide la respuesta por partes a Ollama (NDJSON)
// o a llama-server (SSE) y arma el mismo texto que sin stream; un servidor que se cuelga o corta
// falla como sin stream.

/** Ollama falso: /api/chat con stream responde NDJSON en trozos (algunos cortan una linea a la mitad). */
async function startFakeOllama(pieces: string[], options: { doneReason?: string } = {}) {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      if (body.stream !== true) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ message: { content: pieces.join("") }, done: true, done_reason: options.doneReason || "stop", prompt_eval_count: 40, eval_count: pieces.length }));
        return;
      }
      res.setHeader("Content-Type", "application/x-ndjson");
      const lines = [
        ...pieces.map((piece) => JSON.stringify({ message: { role: "assistant", content: piece }, done: false })),
        JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: options.doneReason || "stop", prompt_eval_count: 40, eval_count: pieces.length }),
      ].join("\n") + "\n";
      // En trozos de 7 bytes: las lineas llegan cortadas entre dos trozos.
      const bytes = Buffer.from(lines, "utf8");
      let offset = 0;
      const tick = () => {
        if (offset >= bytes.length) return res.end();
        res.write(bytes.subarray(offset, offset + 7));
        offset += 7;
        setImmediate(tick);
      };
      tick();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const ANSWER_PIECES = ["1) Resumen:\n- Falta ", "usar la clase.\n", "\n4) Accion:\nAplicar: insert\n", "```cpp\n    cout << \"Hola ñandú\";\n```\n", "\n6) Riesgos:\n- Compila."];

test("runText con stream: el Ollama falso por NDJSON da el mismo texto que sin stream y avisa el acumulado", async () => {
  const ollama = await startFakeOllama(ANSWER_PIECES);
  try {
    await withEnv({ OLLAMA_BASE_URL: ollama.base, TEXT_MODEL_API: undefined, OPENAI_BASE: undefined }, async () => {
      const plain = await runText("hola", {}, { profile: "editor" });
      const seen: string[] = [];
      const streamed = await runText("hola", {}, { profile: "editor" }, undefined, (text) => seen.push(text));
      assert.equal(streamed, plain, "el mismo texto con y sin stream");
      assert.equal(streamed, ANSWER_PIECES.join(""));
      assert.ok(seen.length >= ANSWER_PIECES.length - 1, `avisos: ${seen.length}`);
      for (let index = 1; index < seen.length; index += 1) {
        assert.ok(seen[index].startsWith(seen[index - 1]), "cada aviso trae todo lo anterior");
      }
      assert.equal(seen.at(-1), streamed);
      assert.equal(ollama.bodies[0].stream, false, "sin aviso: stream false, como siempre");
      assert.equal(ollama.bodies[1].stream, true);
      const options = ollama.bodies[1].options as Record<string, unknown>;
      assert.equal(options.num_predict, resolveTextGeneration({ profile: "editor" }).maxTokens, "respeta num_predict");
      assert.equal(options.num_ctx, (ollama.bodies[0].options as Record<string, unknown>).num_ctx);
    });
  } finally {
    await ollama.close();
  }
});

test("runText con stream: una respuesta vacia falla como sin stream", async () => {
  const ollama = await startFakeOllama(["", "   "]);
  try {
    await withEnv({ OLLAMA_BASE_URL: ollama.base, TEXT_MODEL_API: undefined, OPENAI_BASE: undefined }, async () => {
      await assert.rejects(runText("hola", {}, {}, undefined, () => {}), /Sin salida del modelo/);
    });
  } finally {
    await ollama.close();
  }
});

/** llama-server falso (API compatible con OpenAI): SSE con stream, JSON sin stream. */
async function startFakeOpenAi(pieces: string[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      if (body.stream !== true) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: "c", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: pieces.join("") } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        return;
      }
      res.setHeader("Content-Type", "text/event-stream");
      for (const piece of pieces) {
        res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("runText con stream por la API compatible con OpenAI (llama-server de las Mac): mismo texto, avisa el acumulado", async () => {
  const server = await startFakeOpenAi(ANSWER_PIECES);
  try {
    await withEnv({ OPENAI_BASE: server.base, TEXT_MODEL_API: "openai", OLLAMA_BASE_URL: undefined }, async () => {
      const plain = await runText("hola", {}, { profile: "editor" });
      const seen: string[] = [];
      const streamed = await runText("hola", {}, { profile: "editor" }, undefined, (text) => seen.push(text));
      assert.equal(streamed, plain);
      assert.equal(seen.at(-1), streamed);
      assert.equal(server.bodies[0].stream, undefined, "sin aviso no se pide stream");
      assert.equal(server.bodies[1].stream, true);
      assert.equal(server.bodies[1].max_tokens, resolveTextGeneration({ profile: "editor" }).maxTokens);
    });
  } finally {
    await server.close();
  }
});

test("buildOllamaChatBody: sin stream sigue en false (camino de siempre)", () => {
  const settings = resolveTextGeneration({ profile: "editor" });
  assert.equal(buildOllamaChatBody("x", settings, "m").stream, false);
  assert.equal(buildOllamaChatBody("x", settings, "m", true).stream, true);
});

test("readNdjsonLines junta las lineas cortadas entre trozos y la ultima sin salto", async () => {
  const encoder = new TextEncoder();
  const chunks = ["{\"a\":1}\n{\"b\"", ":2}\n\n{\"c\":", "3}"];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const lines: string[] = [];
  for await (const line of readNdjsonLines(body)) lines.push(line);
  assert.deepEqual(lines, ["{\"a\":1}", "{\"b\":2}", "{\"c\":3}"]);
});

/** Servidor que manda unos trozos y despues no cierra ni manda mas (o cierra sin la ultima linea). */
async function startStallingServer(write: (res: http.ServerResponse) => void) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => write(res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function sseChunk(piece: string) {
  return `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`;
}

test("runText en vivo por la API compatible con OpenAI: un servidor que se cuelga a mitad falla por plazo (reintentable), no devuelve media respuesta", async () => {
  const server = await startStallingServer((res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.write(sseChunk("Hola"));
    res.write(sseChunk(" mundo"));
    // y no manda mas
  });
  try {
    await withEnv({ OPENAI_BASE: `http://127.0.0.1:${server.port}/v1`, TEXT_MODEL_API: "openai", OLLAMA_BASE_URL: undefined }, async () => {
      const seen: string[] = [];
      const started = Date.now();
      const error = await runText("hola", {}, {}, 2000, (text) => seen.push(text)).then(
        () => assert.fail("una respuesta cortada no puede volver como exito"),
        (caught: unknown) => caught,
      );
      assert.ok(Date.now() - started >= 1900, "espera el plazo");
      assert.equal((error as Error).name, "TimeoutError");
      assert.equal(seen.at(-1), "Hola mundo", "los parciales si llegaron");
      assert.deepEqual(
        decideJobFailure({ error, deliveryCount: 1, maxAttempts: 3 }),
        { settlement: "abandon", sendResult: false, reason: "retry" },
        "como sin stream: se libera para otro worker",
      );
    });
  } finally {
    await server.close();
  }
});

test("runText en vivo con Ollama: un cuerpo que cierra sin la linea done es una respuesta cortada", async () => {
  const server = await startStallingServer((res) => {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.end(`${JSON.stringify({ message: { content: "Hola a medias" }, done: false })}\n`);
  });
  try {
    await withEnv({ OLLAMA_BASE_URL: `http://127.0.0.1:${server.port}`, TEXT_MODEL_API: undefined, OPENAI_BASE: undefined }, async () => {
      await assert.rejects(runText("hola", {}, {}, 5000, () => {}), /Ollama \/api\/chat: respuesta cortada/);
    });
  } finally {
    await server.close();
  }
});

test("runText en vivo con Ollama: un servidor que se cuelga a mitad falla por plazo (reintentable), igual que sin stream", async () => {
  const server = await startStallingServer((res) => {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.write(`${JSON.stringify({ message: { content: "Hola" }, done: false })}\n`);
  });
  try {
    await withEnv({ OLLAMA_BASE_URL: `http://127.0.0.1:${server.port}`, TEXT_MODEL_API: undefined, OPENAI_BASE: undefined }, async () => {
      const error = await runText("hola", {}, {}, 1500, () => {}).then(() => assert.fail("no puede ser exito"), (caught: unknown) => caught);
      assert.equal((error as Error).name, "TimeoutError");
      assert.equal(decideJobFailure({ error, deliveryCount: 1, maxAttempts: 3 }).settlement, "abandon");
    });
  } finally {
    await server.close();
  }
});
