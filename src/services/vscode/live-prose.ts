// Prosa en vivo de /suggest-tab (01-11-2026): de la respuesta que el modelo lleva escrita, lo que
// VS Code puede mostrar mientras llega el resto. Decision de Eyder: «texto en vivo, codigo al
// final»: el codigo sale solo en la respuesta final, ya recortado (politica, etapa, code-cut y
// referencia del examen), y en vivo nunca se ve codigo ni lineas de la solucion de referencia.
//
// Reglas (sobre el texto acumulado, cada vez desde el comienzo; el resultado de un texto mas largo
// siempre extiende al de uno mas corto):
//   1. solo lineas completas (hasta el ultimo salto de linea): una linea a medias puede ser el
//      comienzo de una valla o de una linea de la referencia;
//   2. se corta en la primera linea que trae ``` o ~~~ en cualquier punto (el comienzo de un
//      bloque de codigo): de ahi en adelante nada sale en vivo;
//   3. sin la linea «Aplicar:» ni el encabezado «Accion» (solo la anuncia);
//   4. sin las lineas que parecen codigo escrito sin valla (looksLikeCodeLine): con ; { o } fuera
//      de las comillas invertidas, una sentencia («if (», «for (», «else», «return x»,
//      «cout <<», «int main()», «max = v[i]», «i++», «print(x)»...), operadores de codigo
//      (<< >> && || == !=), #include/import, sangria de bloque o un «for ...:» de Python. Lo que va
//      entre comillas invertidas en una frase («usa `max` para...») es prosa. Ante la duda se
//      esconde: la linea llega igual en la respuesta final;
//   5. con la referencia del examen cargada, sin las lineas que parecen copiadas de ella
//      (createReferenceLineCheck, mas estricto que el filtro final: sin cupo) y sin las que traen
//      ; { o } en cualquier punto, tambien entre comillas invertidas;
//   6. sin caracteres chinos, japoneses ni coreanos (stripForeignScript, como la respuesta final).
// La respuesta final no pasa por aqui: sale de finalizeEditorSuggestion como siempre.
import { stripForeignScript } from "../shared/text-utils.js";

/** Tope del texto en vivo (la respuesta completa del editor ronda los 5000 caracteres). */
export const LIVE_PROSE_MAX_CHARS = 12_000;

const FENCE_ANYWHERE = /```|~~~/;
const APPLY_LINE = /^[ \t>*-]*(?:\d+\s*[).:-]?\s*)?(?:\*\*)?(?:acci[oó]n\s*:?\s*)?`?aplicar\s*:/i;
/** «4) Accion:» solo, o con la accion sin «Aplicar» («Accion: `insert`»). */
const ACTION_HEADING = /^[ \t>*-]*(?:#+\s*)?(?:\*\*)?\s*(?:\d+\s*[).:-]?\s*)?acci[oó]n\s*:?\s*(?:\*\*)?\s*(?:`?(?:insert|replace|delete)`?\s*)?$/i;
/** Revision independiente (01-11-2026): siempre, no solo con el examen (fuera de `codigo`). */
const CODE_PUNCTUATION = /[;{}]/;
/** «if (», «for(», «while (», «switch (», «catch (», «elif (». */
const CONTROL_STATEMENT = /^(?:if|for|while|switch|catch|elif)\s*\(/;
/** «else», «else if ...», «do», «try» solos en la linea. */
const BARE_KEYWORD = /^(?:else(?:\s+if\b.*)?|do|try|finally)\s*:?\s*$/;
/** Entrada y salida: «cout << ...», «cin >> n», «printf(», «print(», «System.out.println(». */
const IO_STATEMENT = /^(?:std::)?(?:cout|cin|cerr|printf|scanf|puts|print|System\.out\.print(?:ln|f)?)\s*(?:<<|>>|\()/;
/**
 * Declaracion: un tipo y despues «(», «=», «[», «,» o el fin de la linea, directo («int = ...») o
 * despues de un nombre («int main()», «double area», «string nombre = ...»). «int es un tipo
 * entero» no: despues del nombre sigue una palabra.
 */
const DECLARATION = /^(?:(?:const|static|unsigned|signed)\s+)*(?:int|double|float|char|bool|void|string|auto|long|short|std::string|String|vector\s*<[^>]*>)\s*[*&]?\s*(?:[A-Za-z_]\w*(?:::\w+)?\s*)?(?:\(|=|\[|,|$)/;
/** «class Cuenta», «struct Nodo : Base». */
const TYPE_DECLARATION = /^(?:class|struct|interface|enum)\s+[A-Za-z_]\w*\s*(?::.*)?$/;
/** «return», «return max», «return a + b», «return (x)», «return 0»; no «return devuelve el valor». */
const RETURN_STATEMENT = /^return(?:\s*$|\s*[(\-!"'\d]|\s+[A-Za-z_][\w.[\]]*\s*(?:$|[-+*/%<>=!&|?(]))/;
/** Asignacion o incremento al comienzo: «max = v[i]», «total += monto», «i++», «p->x = 1». */
const ASSIGNMENT = /^[A-Za-z_][\w.]*(?:\[[^\]]*\])*(?:->\w+)*\s*(?:[-+*/%]?=(?!=)|\+\+|--)/;
/** Una llamada sola en la linea, sin espacio antes del parentesis: «imprimir(x)», «obj.metodo(a, b)». */
const CALL_STATEMENT = /^[A-Za-z_][\w.:]*(?:<[^>]*>)?\([^()]*(?:\([^()]*\)[^()]*)*\)\s*$/;
/** Operadores que en prosa van entre comillas invertidas. */
const CODE_OPERATORS = /<<|>>|&&|\|\||==|!=/;
const CODE_STATEMENT_START = /^\s*(?:#\s*(?:include|define|ifndef|ifdef|endif|pragma)\b|import\s+[\w.*{]|using\s+namespace\b|package\s+[\w.]+;|from\s+\w[\w.]*\s+import\b)/;
const LIST_MARKER = /^\s*(?:[-*+]\s+|\d{1,3}[.)]\s+|>\s*)/;
/** Una linea de Python (o pseudocodigo) que abre un bloque: «for i in range(3):», «def f(x):». */
const PYTHON_BLOCK = /^\s*(?:def|class|for|while|if|elif|else|try|except|finally|with)\b[^\n]*:\s*$/;
/** Sangria de bloque de codigo de Markdown (4 espacios o un tabulador) que no es una lista. */
const INDENTED_CODE = /^(?: {4,}|\t)(?![-*+]\s|\d{1,3}[.)]\s)\S/;

export type LiveProseOptions = {
  /** La linea parece copiada de la referencia del examen (exam-reference.ts). Sin examen: undefined. */
  isReferenceLine?: (line: string) => boolean;
};

const SPANISH_STOPWORD = /(?:^|[^\p{L}])(?:de|la|el|los|las|que|en|si|no|se|un|una|y|con|para|por|es|del|al|lo|su|cuando)(?=$|[^\p{L}])/giu;

/**
 * «La variable max empieza en 0; si todos son negativos, el resultado queda mal»: un punto y coma de
 * prosa en espanol. Solo cuenta si separa dos frases (espacio y una letra despues, nada pegado ni
 * al final), la linea no trae llaves, parentesis, corchetes ni operadores, y tiene al menos seis
 * palabras con dos o mas palabras comunes del espanol. «int a; int b» o «x++; y++» siguen siendo codigo.
 */
function isProseSemicolonLine(text: string) {
  if (!/;\s+[\p{L}¿¡]/u.test(text) || /;\S|;\s*$/.test(text)) return false;
  if (/[{}()[\]=<>]|\+\+|--/.test(text)) return false;
  const words = text.match(/\p{L}{2,}/gu) ?? [];
  const stopwords = text.match(SPANISH_STOPWORD) ?? [];
  return words.length >= 6 && stopwords.length >= 2;
}

/** La linea, sin la marca de lista, sin el codigo entre comillas invertidas. */
function proseOutsideInlineCode(line: string) {
  return line.replace(LIST_MARKER, "").replace(/`[^`\n]*`/g, "");
}

/**
 * Parece codigo escrito sin valla (no prosa). Se mira la linea sin la marca de lista y sin lo que
 * va entre comillas invertidas: «usa `max` para guardar el mayor» y «prueba con `x++;`» son prosa.
 */
export function looksLikeCodeLine(line: string) {
  if (INDENTED_CODE.test(line) || PYTHON_BLOCK.test(line)) return true;
  const outside = proseOutsideInlineCode(line).trim();
  if (!outside) return false;
  return (CODE_PUNCTUATION.test(outside) && !isProseSemicolonLine(outside))
    || CODE_STATEMENT_START.test(outside)
    || CONTROL_STATEMENT.test(outside)
    || BARE_KEYWORD.test(outside)
    || IO_STATEMENT.test(outside)
    || DECLARATION.test(outside)
    || TYPE_DECLARATION.test(outside)
    || RETURN_STATEMENT.test(outside)
    || ASSIGNMENT.test(outside)
    || CALL_STATEMENT.test(outside)
    || CODE_OPERATORS.test(outside);
}

/** La prosa que se puede mostrar en vivo de un texto acumulado del modelo. */
export function liveProseFromModelText(raw: string, options: LiveProseOptions = {}) {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) return "";
  const kept: string[] = [];
  let length = 0;
  for (const rawLine of text.slice(0, lastNewline).split("\n")) {
    if (FENCE_ANYWHERE.test(rawLine)) break;
    const line = stripForeignScript(rawLine).replace(/\s+$/, "");
    if (!line.trim()) {
      kept.push("");
      continue;
    }
    if (APPLY_LINE.test(line) || ACTION_HEADING.test(line)) continue;
    if (looksLikeCodeLine(line)) continue;
    if (options.isReferenceLine) {
      if (/[;{}]/.test(line) || options.isReferenceLine(line)) continue;
    }
    length += line.length + 1;
    if (length > LIVE_PROSE_MAX_CHARS) break;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Lleva la prosa en vivo de un pedido: update() con el texto acumulado devuelve la prosa nueva si
 * cambio (null si no); reset() la olvida (la segunda llamada del reintento empieza de cero).
 */
export function createLiveProseTracker(options: LiveProseOptions = {}) {
  let last = "";
  return {
    update(raw: string): string | null {
      const prose = liveProseFromModelText(raw, options);
      if (!prose || prose === last) return null;
      last = prose;
      return prose;
    },
    reset() {
      last = "";
    },
    get current() {
      return last;
    },
  };
}

type TimerHandle = unknown;

/**
 * Tope de frecuencia para escribir la prosa en la respuesta: la primera sale enseguida y despues
 * como mucho una por intervalo (siempre la ultima). flush() la manda ya si quedo una pendiente;
 * cancel() la descarta. Sin promesas: nada queda esperando.
 */
export function createProseThrottle(options: {
  intervalMs: number;
  emit: (text: string) => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}) {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: TimerHandle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let pending: string | null = null;
  let lastEmitAt = Number.NEGATIVE_INFINITY;
  let timer: TimerHandle | null = null;

  const fire = () => {
    timer = null;
    if (pending === null) return;
    const text = pending;
    pending = null;
    lastEmitAt = now();
    options.emit(text);
  };

  return {
    push(text: string) {
      pending = text;
      if (timer !== null) return;
      const wait = Math.max(0, lastEmitAt + options.intervalMs - now());
      if (wait === 0) fire();
      else timer = setTimer(fire, wait);
    },
    flush() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      fire();
    },
    cancel() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      pending = null;
    },
  };
}
