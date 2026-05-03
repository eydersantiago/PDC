# Google login y PostgreSQL local

Esta guia deja el flujo completo para usar Google Login en la extension y guardar usuarios/sesiones en PostgreSQL administrado desde pgAdmin4.

## 1. Extension Chrome

El manifest debe tener estos puntos:

- `"key"` con la public key del item `ADACEEN` en Chrome Web Store.
- `"permissions"` debe incluir `"identity"`.
- `"oauth2.client_id"` debe ser el OAuth Client ID de tipo `Chrome Extension / Chrome App`.
- `"oauth2.scopes"` debe incluir `userinfo.email` y `userinfo.profile`.

Despues de editar el manifest, recarga la extension en `chrome://extensions` y confirma que el ID siga siendo:

```text
gkkcnlcbdjdjcibkkbhpopichconbojg
```

## 2. Google Cloud

En el proyecto `adaceen`:

1. Abre `Google Auth Platform`.
2. Configura la pantalla de consentimiento OAuth si aun no esta lista.
3. En `Clients`, crea un cliente de tipo `Chrome Extension / Chrome App`.
4. Usa este Application ID:

```text
gkkcnlcbdjdjcibkkbhpopichconbojg
```

5. Copia el client ID generado y ponlo en:

```env
GOOGLE_CLIENT_ID=tu_client_id.apps.googleusercontent.com
```

## 3. PostgreSQL desde pgAdmin4

pgAdmin4 no es la base de datos; es la herramienta grafica. El backend se conecta al servidor PostgreSQL mediante `DATABASE_URL`.

En pgAdmin4:

1. Conectate a tu servidor local de PostgreSQL.
2. Crea una base de datos, por ejemplo `agente`.
3. Opcionalmente crea un usuario dedicado, por ejemplo `adaceen_user`.
4. Si usas usuario dedicado, asignale permisos sobre la base.

Ejemplo SQL desde `Query Tool`:

```sql
create user adaceen_user with password 'cambia_esta_password';
create database agente owner adaceen_user;
grant all privileges on database agente to adaceen_user;
```

Luego configura `.env`:

```env
DATABASE_URL=postgresql://adaceen_user:cambia_esta_password@localhost:5432/agente
DATABASE_SSL_MODE=disable
```

Si usas el usuario `postgres`, la forma es:

```env
DATABASE_URL=postgresql://postgres:tu_password@localhost:5432/agente
DATABASE_SSL_MODE=disable
```

## 4. Backend

Variables necesarias:

```env
GOOGLE_CLIENT_ID=tu_client_id.apps.googleusercontent.com
GOOGLE_DEFAULT_PASSWORD=una_password_larga_aleatoria
GOOGLE_ALLOWED_HOSTED_DOMAIN=
DATABASE_URL=postgresql://usuario:password@localhost:5432/agente
DATABASE_SSL_MODE=disable
```

Si quieres limitar acceso solo a un dominio institucional:

```env
GOOGLE_ALLOWED_HOSTED_DOMAIN=univalle.edu.co
```

Arranque:

```powershell
npm run build
npm run dev
```

En `/health`, `database_provider` debe salir como `postgres` y `google_auth_configured` debe salir `true`.

## 5. Flujo esperado

1. Usuario abre Campus Virtual, GitHub o Codespaces.
2. Pulsa la extension `ADACEEN`.
3. Pulsa `Empezar`.
4. Pulsa `Continuar con Google`.
5. Chrome pide autorizacion de Google.
6. La extension recibe un access token.
7. El backend valida el token contra Google.
8. El backend crea o recupera el usuario en PostgreSQL.
9. El backend crea una sesion ADACEEN y devuelve `session.id`.
10. La extension guarda `session.id` en `chrome.storage.local` y continua con el tutor.

