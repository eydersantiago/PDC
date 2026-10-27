# Evidencias del navegador 0.8.5: «Cambiar a <cuenta>» (26 oct 2026)

Simulación en Chromium real del cambio de cuenta de VS Code. Se carga la extensión empaquetada, con los shadow roots
abiertos para poder leerlos. vscode.dev se reemplaza por `vscode-falso.html`, un workbench con las clases y los eventos
del VS Code real (1.143, leídos de su código):

- `mousedown` en el botón de cuentas;
- `mouseup` en las opciones del menú, que VS Code escucha 100 ms después de dibujarlas;
- `click` en los botones de los diálogos;
- un diálogo a la vez.

GitHub se reemplaza por un selector de cuentas falso.

| Captura | Qué muestra |
|---|---|
| `A-00-aviso.png` | El aviso «Tu editor no aparece con esta cuenta de GitHub» con «Cambiar a montysansu-cmyk» como botón principal |
| `A-03.png` | ADACEEN pulsa la otra cuenta en el menú de cuentas (anillo «ADACEEN pulsa «eydersantiago (GitHub)»») |
| `A-05.png` | La confirmación de VS Code con el anillo en «Cerrar sesión» |
| `A-99-paso4-tras-recargar.png` | Después de recargar: el paso 4 dice qué cuenta se cerró y marca «Permitir» |
| `B-01-guiado.png` | Un botón que no responde: el aviso se ensancha con el dibujo y lo pide al estudiante |
| `B-02a-cancelo.png` | El estudiante canceló la confirmación: ADACEEN abre el menú, ve que la cuenta sigue y no la da por cerrada |
| `C-01-selector.png` | El selector de cuentas de GitHub con la cuenta del editor marcada |

Falta probarlo en vscode.dev real con dos cuentas (P1.7d en `docs/piloto/prueba-inicio-a-fin.md`).
