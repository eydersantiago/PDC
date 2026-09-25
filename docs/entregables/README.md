# Entregables en Word

Copias en Word de los documentos que se usan fuera del repositorio (validación con el
docente y el director, prueba de inicio a fin). La fuente es siempre el Markdown; si
cambia, se regeneran con pandoc desde la carpeta del documento:

```bash
pandoc guia-instalacion-uso.md -f gfm -t docx --resource-path=. -o ../docs/entregables/guia-instalacion-uso-adaceen.docx
```

| Word | Fuente |
|---|---|
| guia-instalacion-uso-adaceen.docx | [docs/guia-instalacion-uso.md](../guia-instalacion-uso.md) |
| prueba-inicio-a-fin-adaceen.docx | [docs/piloto/prueba-inicio-a-fin.md](../piloto/prueba-inicio-a-fin.md) |
| despliegue-adaceen.docx | [docs/operacion/despliegue.md](../operacion/despliegue.md) |
