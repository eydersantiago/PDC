# Agente Proxy + Extension (Guia de desarrollo y ejecucion)

Este repositorio tiene dos carpetas principales:

- `agente-proxy-azure/`: backend Node.js + TypeScript (proxy/API + DB).
- `browser-ext-prod/`: extension de navegador (Manifest V3).

## Requisitos

- Node.js 20+
- npm 10+
- Navegador Chromium (Chrome, Edge o Brave)

## 1) Backend (`agente-proxy-azure`)

### Preparacion inicial

```bash
cd agente-proxy-azure
npm install
```

Crear `.env` desde `.env.example`:

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS/Linux:

```bash
cp .env.example .env
```

### Comandos de desarrollo y ejecucion

```bash
# desarrollo (hot reload con tsx)
npm run dev

# compilar a dist/
npm run build

# ejecutar compilado (produccion/local)
npm run start

# tests (placeholder actual)
npm test
```

### Comandos de base de datos (Drizzle + PostgreSQL)

```bash
# generar nueva migracion desde src/db/schema.ts
npm run db:generate

# aplicar migraciones pendientes (usa DATABASE_URL)
npm run db:migrate

# abrir Drizzle Studio
npm run db:studio
```

Notas:

- Si `DATABASE_URL` esta vacia, el backend usa PostgreSQL en memoria (`pg-mem`) con seed demo.
- Para Azure PostgreSQL, define `DATABASE_URL` con `sslmode=require`.

## 2) Extension (`browser-ext-prod`)

Esta carpeta no requiere `npm install` ni build; se carga directamente como extension descomprimida.

```bash
cd browser-ext-prod
```

### Ejecutar en modo desarrollo (Chrome/Edge)

1. Abrir `chrome://extensions/` o `edge://extensions/`.
2. Activar `Modo desarrollador`.
3. Clic en `Cargar descomprimida`.
4. Seleccionar la carpeta `browser-ext-prod`.
5. En el popup de la extension, configurar Backend URL: `http://127.0.0.1:3000` (o la URL Azure).

## Flujo recomendado (ambas carpetas)

1. Levantar backend con `npm run dev` en `agente-proxy-azure/`.
2. Cargar `browser-ext-prod/` en el navegador.
3. Probar la extension contra el backend local o Azure.
