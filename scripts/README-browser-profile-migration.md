# Migracion de Chrome, Atlas y VS Code entre Macs

Este paquete sirve para mover configuracion migrable de Chrome, Atlas y VS Code
a otra Mac sin repetir todos los pasos manuales.

## Que incluye

Para Chrome / Atlas:

- Bookmarks.
- Preferencias del perfil.
- Extensiones instaladas y configuracion migrable.
- Datos locales no sensibles del perfil.

Para VS Code:

- Extensiones instaladas en `~/.vscode/extensions`.
- Settings de usuario.
- Keybindings.
- Snippets.
- Lista de extensiones en `extensions.txt`, si el comando `code` esta instalado.

## Que no incluye

Por seguridad y compatibilidad entre Macs, el script excluye:

- Cookies.
- Sesiones abiertas.
- Password databases.
- Tokens de autenticacion.
- Datos cifrados con el Keychain local.
- Auth storage de VS Code.
- Workspace storage e historial local de VS Code.

Despues de restaurar en la otra Mac, tendras que iniciar sesion de nuevo en los
sitios y, si aplica, activar Chrome Sync, el sync propio de Atlas o Settings
Sync de VS Code.

## Crear backup en la Mac original

Cierra Chrome, Atlas y VS Code antes de ejecutar el script.

```bash
cd agente-proxy-azure

# Solo Chrome
scripts/migrate-browser-profile.sh backup chrome

# Solo Atlas
scripts/migrate-browser-profile.sh backup atlas

# Solo VS Code
scripts/migrate-browser-profile.sh backup vscode

# Chrome, Atlas y VS Code
scripts/migrate-browser-profile.sh backup all
```

Por defecto, el archivo `.tar.gz` queda en el Escritorio. Tambien puedes elegir
una carpeta de salida:

```bash
scripts/migrate-browser-profile.sh backup chrome "$HOME/Downloads"
```

## Subir a Drive

Sube a Google Drive:

- `scripts/migrate-browser-profile.sh`
- Este README.
- El archivo generado `browser-profile-*.tar.gz`

Si ejecutaste `backup all`, se generara un `.tar.gz` por cada objetivo:

- `browser-profile-chrome-*.tar.gz`
- `browser-profile-atlas-*.tar.gz`
- `browser-profile-vscode-*.tar.gz`

## Restaurar en la nueva Mac

Descarga el `.tar.gz` desde Drive, cierra el navegador correspondiente y corre:

```bash
cd agente-proxy-azure
scripts/migrate-browser-profile.sh restore "$HOME/Downloads/browser-profile-chrome-YYYYMMDD-HHMMSS.tar.gz"
```

Cambia el nombre del archivo por el backup real que descargaste. Para VS Code:

```bash
scripts/migrate-browser-profile.sh restore "$HOME/Downloads/browser-profile-vscode-YYYYMMDD-HHMMSS.tar.gz"
```

## Verificacion rapida

Abre el navegador restaurado y revisa:

- Bookmarks visibles.
- Extensiones instaladas.
- Preferencias principales del perfil.

Abre VS Code y revisa:

- Extensiones visibles en la vista Extensions.
- Settings de usuario.
- Keybindings.
- Snippets.

Luego inicia sesion donde haga falta.

## Nota recomendada

Si necesitas replicar absolutamente todo el usuario, incluyendo sesiones y
Keychain, usa Apple Migration Assistant. Para una migracion portable y mas
controlada, usa este script y vuelve a autenticarte en la Mac destino.
