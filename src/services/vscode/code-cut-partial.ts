// Recorte del codigo: reemplazo parcial de la seleccion (buildPartialReplacement) con los cambios que alcanzan el cupo.
import { measureBracketShape, sameShape } from "./code-cut-brackets.js";
import { indentColumns, isCodeLine, endsCleanly } from "./code-cut-prefix.js";
import { isSignificantCodeLine, type CodeFamily, type PartialReplacement, splitLines, isElisionMarkerLine, countChangedLines } from "./code-cut.js";

// --- Reemplazo parcial -----------------------------------------------------------------------

type DiffOp =
  | { kind: "equal"; a: number; b: number }
  | { kind: "modify"; a: number; b: number }
  | { kind: "insert"; b: number }
  | { kind: "delete"; a: number };

/** Clave de una linea para comparar: sin espacios (int main(){ y int main() { son la misma). */
function lineKey(line: string) {
  return line.replace(/\s+/g, "");
}

/** Mas de esto (lineas de la seleccion x lineas propuestas) no se compara: queda como guia. */
const MAX_DIFF_CELLS = 60_000;

/** Diferencia por lineas (subsecuencia comun mas larga), en orden: igual, quitar, agregar. */
function diffLines(a: string[], b: string[]): DiffOp[] {
  const keysA = a.map(lineKey);
  const keysB = b.map(lineKey);
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = keysA[i] === keysB[j]
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && keysA[i] === keysB[j]) {
      ops.push({ kind: "equal", a: i, b: j });
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && table[(i + 1) * cols + j] >= table[i * cols + j + 1])) {
      ops.push({ kind: "delete", a: i });
      i += 1;
    } else {
      ops.push({ kind: "insert", b: j });
      j += 1;
    }
  }
  return ops;
}

/** Palabras, numeros y cadenas de una linea (los simbolos no cuentan: `<<` o `;` estan en todas). */
function codeTokens(line: string) {
  return line.match(/[\p{L}_][\p{L}\p{N}_]*|\d+(?:\.\d+)?|"[^"]*"|'[^']*'/gu) || [];
}

/** Parecido entre dos lineas (coeficiente de Dice sobre sus palabras, numeros y cadenas). */
function lineSimilarity(left: string, right: string) {
  const a = codeTokens(left);
  const b = codeTokens(right);
  if (!a.length || !b.length) return 0;
  const pool = new Map<string, number>();
  for (const token of a) pool.set(token, (pool.get(token) || 0) + 1);
  let common = 0;
  for (const token of b) {
    const available = pool.get(token) || 0;
    if (available > 0) {
      pool.set(token, available - 1);
      common += 1;
    }
  }
  return (2 * common) / (a.length + b.length);
}

/**
 * Desde este parecido una linea quitada y una agregada son la misma linea cambiada. Alto a
 * proposito: `cout << "Hola";` y `cout << "Saldo: " << s;` no son la misma, y la del estudiante
 * se queda en vez de cambiarse por otra.
 */
const MODIFY_SIMILARITY = 0.6;

// --- Nombre que declara o asigna una linea (31-10-2026) --------------------------------------
// Revision independiente: `int saldo;` -> `double saldo;` se parece 0,5 (solo comparten «saldo»),
// no llegaba a MODIFY_SIMILARITY y quedaba como «quitar» + «agregar»; el reemplazo parcial
// aplicaba la agregada y dejaba la quitada, y el estudiante recibia `double saldo;` y `int saldo;`
// (una redeclaracion) como codigo aplicable. Dos lineas que declaran o asignan el mismo nombre son
// la misma linea cambiada, se parezcan o no.

/** Palabras que pueden ir antes de un nombre sin ser un tipo (return x; delete p; case X:). */
const NOT_A_TYPE = /^(?:return|delete|throw|goto|case|else|new|using|typedef|namespace|template|operator|if|for|while|switch|do|sizeof|friend|co_return|co_yield|co_await|break|continue|default|print|yield|await|import|from|raise|assert|del|pass|lambda|not|and|or|in|is)$/;

/** «tipo nombre» al comienzo de la linea, seguido de =, ;, coma, (, { o : (int x = 0; void f(int m) {). */
const DECLARATION = /^(?:(?:const|static|constexpr|mutable|volatile|unsigned|signed|long|short|final|inline|virtual|explicit|extern|register|let|var|auto)\s+)*([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*(?:\s*<[^;(){}=]*>)?)(?:\s*[*&]+\s*|\s+)((?:[A-Za-z_]\w*::)*~?[A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*(?:=(?!=)|;|,|\(|\{|:(?!:))/;

/** «nombre = ...», «nombre += ...», «this->nombre = ...», «v[i] = ...» al comienzo de la linea. */
const ASSIGNMENT = /^((?:(?:this|self)\s*(?:->|\.)\s*)?[A-Za-z_]\w*(?:\s*(?:\.|->)\s*[A-Za-z_]\w*)*)\s*(?:\[[^\]]*\]\s*)?(?:[-+*/%&|^]|<<|>>)?=(?!=)/;

/** Nombre que declara la linea (`int saldo;`, `void depositar(int m) {`, `def f(x):`), o "". */
function declaredName(line: string) {
  const match = String(line || "").trim().match(DECLARATION);
  if (!match || NOT_A_TYPE.test(match[1])) return "";
  return match[2];
}

/** Nombre que declara o asigna la linea, sin this-> ni self. (`saldo += m;` -> saldo), o "". */
function declaredOrAssignedName(line: string) {
  const declared = declaredName(line);
  if (declared) return declared;
  const match = String(line || "").trim().match(ASSIGNMENT);
  if (!match || NOT_A_TYPE.test(match[1])) return "";
  return match[1].replace(/\s+/g, "").replace(/^(?:this->|this\.|self\.)/, "");
}

/** Cuantas veces declara cada nombre un bloque (lineas que empiezan con «tipo nombre»). */
function declarationCounts(lines: string[]) {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const name = declaredName(line);
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

/**
 * Dentro de cada tramo distinto, una linea quitada y una agregada son la misma linea cambiada
 * (modify) si declaran o asignan el mismo nombre o, si no, si se parecen. Las agregadas van antes
 * de las quitadas que no se emparejan; un tramo con quitadas sueltas se aplica entero o no se
 * aplica (buildPartialReplacement).
 */
function refineDiff(ops: DiffOp[], a: string[], b: string[]): DiffOp[] {
  const refined: DiffOp[] = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index].kind === "equal") {
      refined.push(ops[index]);
      index += 1;
      continue;
    }
    const deleted: number[] = [];
    const inserted: number[] = [];
    while (index < ops.length && ops[index].kind !== "equal") {
      const op = ops[index];
      if (op.kind === "delete") deleted.push(op.a);
      if (op.kind === "insert") inserted.push(op.b);
      index += 1;
    }
    const pairs: Array<{ d: number; i: number }> = [];
    let from = 0;
    for (let d = 0; d < deleted.length; d += 1) {
      const left = a[deleted[d]];
      const name = declaredOrAssignedName(left);
      let match = -1;
      for (let k = from; name && k < inserted.length && match < 0; k += 1) {
        if (declaredOrAssignedName(b[inserted[k]]) === name) match = k;
      }
      for (let k = from; isSignificantCodeLine(left) && k < inserted.length && match < 0; k += 1) {
        if (lineSimilarity(left, b[inserted[k]]) >= MODIFY_SIMILARITY) match = k;
      }
      if (match >= 0) {
        pairs.push({ d, i: match });
        from = match + 1;
      }
    }
    let nextD = 0;
    let nextI = 0;
    const flush = (untilD: number, untilI: number) => {
      for (; nextI < untilI; nextI += 1) refined.push({ kind: "insert", b: inserted[nextI] });
      for (; nextD < untilD; nextD += 1) refined.push({ kind: "delete", a: deleted[nextD] });
    };
    for (const pair of pairs) {
      flush(pair.d, pair.i);
      refined.push({ kind: "modify", a: deleted[pair.d], b: inserted[pair.i] });
      nextD = pair.d + 1;
      nextI = pair.i + 1;
    }
    flush(deleted.length, inserted.length);
  }
  return refined;
}

/** Columnas por nivel de sangria de un conjunto de lineas (MCD de sus sangrias relativas). */
function indentUnit(lines: string[]) {
  const widths = lines.filter((line) => line.trim()).map(indentColumns);
  if (!widths.length) return 0;
  const base = Math.min(...widths);
  const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
  return widths.map((width) => width - base).filter((width) => width > 0).reduce((acc, width) => gcd(acc, width), 0);
}

function leadingIndent(line: string) {
  return line.match(/^[ \t]*/)?.[0] || "";
}

/**
 * El bloque parcial queda con la sangria del modelo (es la que tiene todas las lineas bien
 * puestas; VS Code re-indenta el bloque entero al aplicarlo): las lineas del estudiante que el
 * modelo conserva o cambia toman la sangria de su linea en el modelo, y las que el modelo
 * quitaba (se dejan) se ubican respecto a la linea conservada mas cercana. La primera linea de la
 * seleccion no sirve de referencia si hay otra: si se selecciono desde el texto llega sin sangria.
 */
function modelFrame(a: string[], b: string[], ops: DiffOp[]) {
  const anchors = ops
    .map((op, index) => ({ op, index }))
    .filter((item): item is { op: Extract<DiffOp, { a: number; b: number }>; index: number } => item.op.kind === "equal" || item.op.kind === "modify");
  const preferred = anchors.filter((item) => item.op.a > 0);
  const pool = preferred.length ? preferred : anchors;
  const originalUnit = indentUnit(a.slice(1));
  const modelUnit = indentUnit(b);
  const scale = originalUnit > 0 && modelUnit > 0 ? modelUnit / originalUnit : 1;
  const useTabs = b.some((line) => /^\t/.test(line)) && !b.some((line) => /^ /.test(line));
  const render = (columns: number, text: string) => {
    const width = Math.max(0, Math.round(columns));
    const indent = useTabs ? "\t".repeat(Math.floor(width / 4)) + " ".repeat(width % 4) : " ".repeat(width);
    return `${indent}${text}`;
  };
  return {
    /** Linea del estudiante con la sangria de su linea en el modelo. */
    kept(originalLine: string, modelLine: string) {
      return originalLine.trim() ? `${leadingIndent(modelLine)}${originalLine.trim()}` : "";
    },
    /** Linea del estudiante que el modelo quitaba, junto a la conservada mas cercana. */
    left(opIndex: number) {
      const op = ops[opIndex] as { a: number };
      const line = a[op.a];
      if (!line.trim()) return "";
      const before = [...pool].reverse().find((item) => item.index < opIndex);
      const anchor = before || pool.find((item) => item.index > opIndex);
      if (!anchor) return line;
      const columns = indentColumns(b[anchor.op.b]) + (indentColumns(line) - indentColumns(a[anchor.op.a])) * scale;
      return render(columns, line.trim());
    },
  };
}

/**
 * Cambios que se aplican juntos en un reemplazo parcial (31-10-2026), con lo que suman a la cuenta
 * de countChangedLines: lineas que agregan (insert y modify) y lineas del estudiante que quitan
 * (modify y delete).
 */
type ChangeGroup = { ops: number[]; added: number; removed: number };

/**
 * Los cambios de la propuesta en orden. En un tramo sin quitadas sueltas cada linea agregada o
 * cambiada va sola (se puede cortar entre ellas). Un tramo con una quitada suelta va entero: su
 * linea nueva puede reemplazar a la quitada (`int saldo;` -> `double saldo;` con otro nombre de
 * tipo), y aplicar la agregada sin quitar la otra deja las dos.
 */
function changeGroups(ops: DiffOp[], a: string[], b: string[]): ChangeGroup[] {
  const groups: ChangeGroup[] = [];
  const weight = (line: string) => (line.trim() ? 1 : 0);
  let index = 0;
  while (index < ops.length) {
    if (ops[index].kind === "equal") {
      index += 1;
      continue;
    }
    const hunk: number[] = [];
    while (index < ops.length && ops[index].kind !== "equal") hunk.push(index++);
    const atomic = hunk.some((at) => {
      const op = ops[at];
      return op.kind === "delete" && Boolean(a[op.a].trim());
    });
    const single = (at: number): ChangeGroup => {
      const op = ops[at];
      return {
        ops: [at],
        added: op.kind === "insert" || op.kind === "modify" ? weight(b[op.b]) : 0,
        removed: op.kind === "delete" || op.kind === "modify" ? weight(a[op.a]) : 0,
      };
    };
    if (!atomic) {
      for (const at of hunk) {
        if (ops[at].kind === "insert" || ops[at].kind === "modify") groups.push(single(at));
      }
      continue;
    }
    const whole = hunk.map(single);
    groups.push({
      ops: hunk,
      added: whole.reduce((sum, item) => sum + item.added, 0),
      removed: whole.reduce((sum, item) => sum + item.removed, 0),
    });
  }
  return groups;
}

/**
 * Reemplazo parcial de la seleccion cuando la propuesta del modelo cambia mas de maxLines lineas:
 * se recorren los cambios en orden (changeGroups) y se aplican mientras alcance el cupo, con la
 * misma cuenta que countChangedLines. Las lineas de la seleccion que quedaron despues del corte, o
 * en un tramo que no se aplico, se dejan como estan. Un tramo que quita lineas del estudiante se
 * aplica entero (agrega y quita) o no se aplica: el parcial nunca deja una linea nueva junto a la
 * que reemplazaba (31-10-2026). Solo vale si:
 *   - la propuesta es una version del bloque (conserva o cambia la mitad o mas de sus lineas
 *     significativas; una reescritura completa no se puede aplicar por partes);
 *   - el resultado deja las llaves como la seleccion, no termina en una construccion a medias ni
 *     separa un try, do o if de su catch, while o else (endsCleanly);
 *   - el resultado no declara un nombre mas veces que la seleccion o la propuesta;
 *   - la propuesta no resume lineas con «...» (no se sabria cuales son).
 * null si no hay un reemplazo parcial asi: el codigo queda como guia.
 */
export function buildPartialReplacement(input: {
  /** La seleccion del estudiante. */
  original: string;
  /** El bloque que propone el modelo para reemplazarla. */
  proposed: string;
  /** Cuantas lineas nuevas o distintas puede traer el reemplazo (el tope de la etapa). */
  maxChangedLines: number;
  family: CodeFamily;
}): PartialReplacement | null {
  const { original, proposed, family } = input;
  const budget = Math.floor(input.maxChangedLines);
  if (budget <= 0 || !String(original || "").trim()) return null;
  const a = splitLines(original);
  const b = splitLines(proposed);
  while (b.length && !b[b.length - 1].trim()) b.pop();
  if (!b.length || b.some(isElisionMarkerLine)) return null;
  if (a.length * b.length > MAX_DIFF_CELLS) return null;

  const ops = refineDiff(diffLines(a, b), a, b);
  const significant = a.filter((line) => isSignificantCodeLine(line.trim()));
  const matched = ops.filter((op) => (op.kind === "equal" || op.kind === "modify") && isSignificantCodeLine(a[op.a].trim())).length;
  if (!significant.length || matched / significant.length < 0.5) return null;

  // Grupos de cambios que se pueden aplicar, en orden, hasta donde alcanza el cupo: lo que agregan
  // y lo que quitan se cuentan aparte, como en countChangedLines (max de las dos).
  const groups: ChangeGroup[] = [];
  let added = 0;
  let removed = 0;
  for (const group of changeGroups(ops, a, b)) {
    if (Math.max(added + group.added, removed + group.removed) > budget) break;
    added += group.added;
    removed += group.removed;
    groups.push(group);
  }

  const total = countChangedLines(original, proposed);
  const originalShape = measureBracketShape(original, family);
  const declaredBefore = declarationCounts(a);
  const declaredInProposal = declarationCounts(b);
  const frame = modelFrame(a, b, ops);
  for (let count = groups.length; count >= 1; count -= 1) {
    const applied = new Set(groups.slice(0, count).flatMap((group) => group.ops));
    const addedOps = [...applied].sort((x, y) => x - y).filter((index) => {
      const op = ops[index];
      return (op.kind === "insert" || op.kind === "modify") && Boolean(b[op.b].trim());
    });
    if (!addedOps.length) continue;
    const lastIndex = addedOps[addedOps.length - 1];
    const lastOp = ops[lastIndex] as { b: number };
    const out: string[] = [];
    let lastOut = -1;
    ops.forEach((op, index) => {
      if (op.kind === "equal") out.push(frame.kept(a[op.a], b[op.b]));
      else if (op.kind === "delete") {
        if (!applied.has(index)) out.push(frame.left(index));
      } else if (op.kind === "modify") out.push(applied.has(index) ? b[op.b] : frame.kept(a[op.a], b[op.b]));
      else if (applied.has(index)) out.push(b[op.b]);
      if (index === lastIndex) lastOut = out.length - 1;
    });
    const following = out.slice(lastOut + 1).find((line) => isCodeLine(line, family)) || "";
    while (out.length && !out[out.length - 1].trim()) out.pop();
    const candidate = out.join("\n");
    const changed = countChangedLines(original, candidate);
    if (changed < 1 || changed > budget) continue;
    if (!sameShape(originalShape, measureBracketShape(candidate, family))) continue;
    if (redeclares(declarationCounts(out), declaredBefore, declaredInProposal)) continue;
    // El ultimo cambio aplicado no puede dejar un bloque a medias (en Python, con la sangria del
    // tramo de lineas nuevas al que pertenece) ni dejar fuera el catch, while o else que seguia.
    let runStart = lastOp.b;
    for (let back = addedOps.length - 2; back >= 0; back -= 1) {
      const op = ops[addedOps[back]] as { b: number };
      if (op.b !== runStart - 1) break;
      runStart = op.b;
    }
    if (!endsCleanly(b, runStart, lastOp.b, family, { following, dropped: droppedAfter(ops, applied, b, lastOp.b, family) })) continue;
    return { code: candidate, changesShown: changed, changesTotal: total };
  }
  return null;
}

/**
 * La siguiente linea de codigo de la propuesta despues de b[after], si el reemplazo parcial la deja
 * fuera (una agregada o cambiada que no se aplico); "" si quedo en el resultado o no hay otra.
 */
function droppedAfter(ops: DiffOp[], applied: Set<number>, b: string[], after: number, family: CodeFamily) {
  let next = -1;
  for (let index = after + 1; index < b.length; index += 1) {
    if (isCodeLine(b[index], family)) {
      next = index;
      break;
    }
  }
  if (next < 0) return "";
  const at = ops.findIndex((op) => op.kind !== "delete" && op.b === next);
  if (at < 0 || ops[at].kind === "equal" || applied.has(at)) return "";
  return b[next];
}

/** El resultado declara algun nombre mas veces que la seleccion y que la propuesta. */
function redeclares(result: Map<string, number>, before: Map<string, number>, proposal: Map<string, number>) {
  for (const [name, count] of result) {
    if (count > Math.max(before.get(name) || 0, proposal.get(name) || 0)) return true;
  }
  return false;
}
