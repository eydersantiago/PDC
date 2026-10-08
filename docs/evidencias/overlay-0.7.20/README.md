# Simulación y capturas de la 0.7.20: el código de GitHub puesto solo

Qué pidió Eyder (8 de octubre de 2026): que el acceso por túnel sea lo más directo
posible y automatizar los pasos que quedaban a mano. Del lado del estudiante, el único
paso que la extensión podía hacer por él era escribir el código de un solo uso en
`github.com/login/device`; lo demás (autorizar en GitHub, entrar a `vscode.dev` con
GitHub) es consentimiento suyo y se queda en sus manos.

## Cómo se hizo

Simulación en Chromium 141 real con Playwright (`sim-codigo-dispositivo.mjs`, en esta
carpeta), el 8 de octubre de 2026:

- **Extensión real** (`browser-ext-prod` 0.7.20) cargada en Chromium. La copia de prueba
  solo cambia una cosa: el shadow root del aviso abierto, para poder leer su texto.
- **`github.com/login/device` simulado**: Playwright intercepta esa URL y sirve una página
  falsa con el formulario, en dos variantes, porque desde el contenedor no se pudo abrir la
  página real (hace falta sesión de GitHub): (a) un solo campo `user_code` (`XXXX-XXXX`)
  más un oculto con el mismo nombre; (b) ocho cuadros de un carácter sin nombre, con el
  mismo comportamiento que GitHub al pegar en el primero (reparte el código) y un oculto
  `user_code` compuesto por la página.
- **Código pendiente** sembrado en `chrome.storage` (el mismo handoff que deja la ventana
  de espera: usuario de ADACEEN, código, repositorio, vencimiento).
- **Nada sale a la red**: el backend responde 503 simulado; `/empezar` y GitHub no se tocan.

Cómo repetirla (desde la raíz del repositorio, sin tocar `package.json`):

```bash
npm i --no-save playwright-core
CHROME_BIN=<ruta a chrome o chromium> node docs/evidencias/overlay-0.7.20/sim-codigo-dispositivo.mjs <carpeta de salida>
```

Imprime `OK` o `FALLA` por variante, deja `resultado.json` y una captura por variante.

## Resultado

| Variante | Qué pasó |
|---|---|
| (a) Un campo | El campo quedó con `WDJB-MJHT`, la página recibió `input` y `change` con ese valor (como si se escribiera), el oculto `user_code` también quedó con el código, el campo de contraseña de otro formulario no se tocó, el formulario **no** se envió y el foco siguió donde lo puso la página (`autofocus` del campo). El aviso dijo «El codigo ya esta en el formulario: pulsa Continue y autoriza con tu cuenta de GitHub. Esta pestana abrira tu editor sola.» y el portapapeles también tenía el código. |
| (b) Ocho cuadros | El `paste` sintético (`ClipboardEvent` con `DataTransfer`) llegó al primer cuadro con el código y la página lo repartió: `W D J B M J H T`, oculto `WDJB-MJHT`, formulario sin enviar, foco sin mover, mismo aviso. |

Lo que la simulación **no** prueba: el marcado real de `github.com/login/device` (no se
pudo abrir sin sesión). Por eso el relleno es a la defensiva: solo toca campos de texto
cuyo nombre, id, clase o `aria-label` digan `user_code` / `device-code` o, sin nombre, ocho
o más cuadros de un carácter dentro de un formulario con `action` `/login/device`; después
de escribir vuelve a leer los campos y, si el código no quedó, no cambia el aviso (sigue
«Codigo copiado: pegalo en el primer cuadro y autoriza…»). Si GitHub cambió su página, el
estudiante pega el código como antes. Nunca se envía el formulario ni se mueve el foco. La
confirmación con la página real es el paso P1.4 de la
[prueba de inicio a fin](../../piloto/prueba-inicio-a-fin.md) (anotar si los cuadros
traían el código).

## Capturas

| Archivo | Qué muestra |
|---|---|
| `01-un-campo.png` | Variante (a): el aviso arriba y el campo de GitHub ya con el código |
| `02-ocho-cuadros.png` | Variante (b): los ocho cuadros con una letra cada uno |

## Pruebas automáticas

El caso «0.7.20» de `tests/scripts/browser-ext-flujo-tunel.test.ts` cubre lo mismo con el
DOM falso del arnés (un campo con oculto, ocho cuadros, un formulario desconocido que no se
toca, un código nuevo en la misma espera; el formulario nunca se envía).
