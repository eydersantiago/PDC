#!/bin/bash
# Prueba de velocidad del modelo en esta Mac: cuanto tardaria una peticion
# tipica del tutor. La usan instalar-worker-mac.sh y "worker-mac.sh velocidad".
#
# Mide con Ollama la lectura del prompt (tokens/s) y la generacion (tokens/s)
# y estima una peticion de VS Code de unos 2000 tokens de entrada y 200 de
# respuesta (estimacion: el tamano real depende del archivo y de la pregunta).
# Sale con 2 si la estimacion pasa del umbral del piloto (p50 <= 8 s).
#
# Variables: NODE_BIN, URL_OLLAMA, MODELO; con MOTOR=llama mide llama-server
# (cluster de Mac) en URL_LLAMA en vez de Ollama.
set -euo pipefail

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/mac/comun.sh
. "$DIR_SCRIPT/comun.sh"

NODE_BIN="${NODE_BIN:-node}"
URL_OLLAMA="${URL_OLLAMA:-http://127.0.0.1:11434}"
URL_LLAMA="${URL_LLAMA:-http://127.0.0.1:8091}"
MOTOR="${MOTOR:-ollama}"
MODELO="${MODELO:-qwen2.5-coder:14b}"

if [ "$MOTOR" = "llama" ]; then
  info "midiendo la velocidad de $MODELO en el cluster (puede tardar un minuto)"
else
  info "midiendo la velocidad de $MODELO en esta Mac (unos segundos)"
fi
set +e
# El programa de node va entre comillas simples: sus ${...} son de JavaScript.
# shellcheck disable=SC2016
URL_OLLAMA="$URL_OLLAMA" URL_LLAMA="$URL_LLAMA" MOTOR="$MOTOR" MODELO="$MODELO" "$NODE_BIN" --input-type=module -e '
const llama = process.env.MOTOR === "llama";
const base = llama ? process.env.URL_LLAMA : process.env.URL_OLLAMA;
const model = process.env.MODELO;
const snippet = [
  "class CuentaBancaria {",
  "  double saldo = 0;",
  "public:",
  "  void depositar(double monto) { if (monto > 0) saldo += monto; }",
  "  bool retirar(double monto) { if (monto > saldo) return false; saldo -= monto; return true; }",
  "  double consultar() const { return saldo; }",
  "};",
  "",
].join("\n");
const prompt = "Eres un tutor de programacion orientada a objetos. Revisa este codigo C++ y explica en dos frases un posible problema de diseno, sin dar la solucion completa.\n\n" + snippet.repeat(28);
let data;
try {
  // Ollama: /api/generate con tiempos en nanosegundos. llama-server: /completion con "timings".
  const response = await fetch(llama ? `${base}/completion` : `${base}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(llama
      ? { prompt, n_predict: 96, temperature: 0, cache_prompt: false }
      : { model, prompt, stream: false, keep_alive: -1, options: { num_predict: 96, temperature: 0 } }),
    signal: AbortSignal.timeout(600000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  data = await response.json();
} catch (error) {
  console.error(`[adaceen] AVISO: no pude medir la velocidad (${error.message})`);
  process.exit(1);
}
const lectura = llama ? data.timings?.prompt_per_second : data.prompt_eval_count / (data.prompt_eval_duration / 1e9);
const generacion = llama ? data.timings?.predicted_per_second : data.eval_count / (data.eval_duration / 1e9);
if (!Number.isFinite(lectura) || !Number.isFinite(generacion) || generacion <= 0 || lectura <= 0) {
  console.error(`[adaceen] AVISO: ${llama ? "llama-server" : "Ollama"} no devolvio los tiempos de la prueba`);
  process.exit(1);
}
const estimado = 2000 / lectura + 200 / generacion;
const f = (n) => n.toLocaleString("es-CO", { maximumFractionDigits: 1 });
console.log(`[adaceen] lectura del prompt: ${f(lectura)} tokens/s; generacion: ${f(generacion)} tokens/s`);
console.log(`[adaceen] una peticion tipica de VS Code (unos 2000 tokens de entrada y 200 de respuesta) tardaria unos ${f(estimado)} s`);
process.exit(estimado > 8 ? 2 : 0);
'
codigo=$?
set -e
if [ "$codigo" = 2 ] && [ "$MOTOR" = "llama" ]; then
  aviso "el cluster pasa del umbral del piloto (mediana de 8 s o menos) con $MODELO."
  aviso "  Es lo esperable al repartir un modelo grande entre Mac: usalo como respaldo (--respaldo) o fuera de las sesiones del piloto."
elif [ "$codigo" = 2 ]; then
  aviso "esta Mac pasa del umbral del piloto (mediana de 8 s o menos) con $MODELO."
  aviso "  Usala junto a la GPU en modo respaldo (--respaldo), o con un modelo menor fuera de las sesiones del piloto."
elif [ "$codigo" = 0 ]; then
  ok "velocidad dentro del umbral del piloto (mediana de 8 s o menos)"
fi
exit "$codigo"
