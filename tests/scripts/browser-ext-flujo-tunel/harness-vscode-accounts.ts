import type { FakeElement } from "./harness-dom.js";
import type { TabEnv } from "./harness-tab.js";

export type FakeAccount = { login: string; provider: "GitHub" | "Microsoft" };

/**
 * vscode.dev de mentira con los eventos del VS Code real (1.143): el boton de cuentas abre el menu
 * con mousedown en su contenedor (despues de resolver las acciones); las opciones del menu
 * responden a mouseup solo 100 ms despues de dibujarse; una cuenta abre su submenu; «Cerrar
 * sesión» pide confirmar en un dialogo que espera a que se cierre el que este abierto (VS Code
 * muestra un dialogo a la vez); los botones de los dialogos responden a click. `deaf`: pantallas
 * que no responden a eventos de la pagina (como un VS Code distinto), solo a la mano del estudiante.
 */
export class FakeVscodeAccounts {
  accounts: FakeAccount[];
  log: string[] = [];
  deaf = new Set<string>();
  tunnelDialog: FakeElement | null = null;
  confirm: FakeElement | null = null;
  confirmButtons: Record<string, FakeElement> = {};
  pendingConfirm = "";
  menu: FakeElement[] = [];
  submenu: FakeElement[] = [];
  submenuOwner = "";
  accountsItem: FakeElement;
  accountsLabel: FakeElement;
  showAccountsButton = true;
  private menuShownAt = 0;
  private submenuShownAt = 0;

  constructor(readonly tab: TabEnv, accounts: FakeAccount[]) {
    this.accounts = accounts.map((account) => ({ ...account }));
    const doc = tab.document;
    this.accountsItem = doc.createElement("li");
    this.accountsLabel = doc.createElement("a");
    this.accountsLabel.classList.add("action-label", "codicon", "codicon-accounts-view-bar-icon");
    this.accountsLabel.setAttribute("aria-label", "Cuentas");
    this.accountsItem.appendChild(this.accountsLabel);
    doc.body.appendChild(this.accountsItem);
    this.accountsItem.addEventListener("mousedown", (event: any) => {
      if (event.button === 2 || this.deaf.has("accounts")) return;
      this.log.push("accounts");
      queueMicrotask(() => this.openMenu());
    });
    doc.querySelectorAll = ((selector: string) => this.query(selector)) as any;
  }

  private get now() { return this.tab.browser.clock.now; }

  query(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    if (selector.includes("monaco-dialog-box")) {
      const dialog = this.tunnelDialog || this.confirm;
      if (dialog) found.push(dialog);
    }
    if (selector.includes(".monaco-menu .action-item")) found.push(...this.menu, ...this.submenu);
    if (selector.includes("codicon-accounts-view-bar-icon") && this.showAccountsButton) found.push(this.accountsLabel);
    return found;
  }

  private node(tag: string, text: string) {
    const node = this.tab.document.createElement(tag);
    node.textContent = text;
    this.tab.document.body.appendChild(node);
    return node;
  }

  private dialog(text: string, buttons: Array<[string, () => void]>) {
    const dialog = this.node("div", text);
    const elements: Record<string, FakeElement> = {};
    for (const [label, onClick] of buttons) {
      const button = this.tab.document.createElement("a");
      button.textContent = label;
      button.addEventListener("click", onClick);
      dialog.appendChild(button);
      elements[label] = button;
    }
    dialog.querySelectorAll = ((selector: string) => (selector.includes("monaco-button") ? Object.values(elements) : [])) as any;
    return { dialog, elements };
  }

  showTunnelDialog() {
    const { dialog } = this.dialog("No se pudo encontrar el túnel con el nombre ws-alumno. Asegúrese de estar usando la misma cuenta que usó para iniciar el túnel.", [
      ["Elegir otra cuenta", () => { this.log.push("elegir"); }],
      ["Cancelar", () => { this.log.push("cancelar"); this.closeTunnelDialog(); }],
    ]);
    this.tunnelDialog = dialog;
  }

  closeTunnelDialog() {
    this.tunnelDialog?.remove();
    this.tunnelDialog = null;
    if (this.pendingConfirm) {
      const login = this.pendingConfirm;
      this.pendingConfirm = "";
      this.showConfirm(login);
    }
  }

  private menuItem(label: string, onMouseUp: () => void, shownAt: () => number, screen: string) {
    const item = this.node("li", label);
    item.addEventListener("mouseup", () => {
      // VS Code registra el mouseup de cada opcion 100 ms despues de dibujarla.
      if (this.now - shownAt() < 100 || this.deaf.has(screen)) return;
      onMouseUp();
    });
    return item;
  }

  openMenu() {
    this.closeMenu();
    this.menuShownAt = this.now;
    this.menu = this.accounts.map((account) => {
      const item = this.menuItem(`${account.login} (${account.provider})`, () => this.openSubmenu(account.login), () => this.menuShownAt, "menu");
      // El submenu va dentro de la opcion de la cuenta.
      item.contains = ((node: unknown) => node === item || (this.submenuOwner === account.login && this.submenu.includes(node as FakeElement))) as any;
      return item;
    });
    this.menu.push(this.menuItem("Copia de seguridad y sincronización de la configuración...", () => {}, () => this.menuShownAt, "menu"));
  }

  openSubmenu(login: string) {
    this.log.push(`menu:${login}`);
    this.submenu.forEach((item) => item.remove());
    this.submenuOwner = login;
    this.submenuShownAt = this.now;
    this.submenu = [
      this.menuItem("Administrar extensiones de confianza", () => {}, () => this.submenuShownAt, "submenu"),
      this.menuItem("Cerrar sesión", () => this.askSignOut(login), () => this.submenuShownAt, "submenu"),
    ];
  }

  closeMenu() {
    [...this.menu, ...this.submenu].forEach((item) => item.remove());
    this.menu = [];
    this.submenu = [];
    this.submenuOwner = "";
  }

  // «Cerrar sesión» del submenu: el menu se cierra y la confirmacion espera al dialogo abierto.
  askSignOut(login: string) {
    this.log.push(`ask:${login}`);
    this.closeMenu();
    if (this.tunnelDialog) this.pendingConfirm = login;
    else this.showConfirm(login);
  }

  showConfirm(login: string) {
    const { dialog, elements } = this.dialog(`La cuenta "${login}" ha sido utilizada por: Remote - Tunnels ¿Desea cerrar la sesión de estas extensiones?`, [
      ["Cerrar sesión", () => {
        if (this.deaf.has("confirm")) return;
        this.signOut(login);
      }],
      ["Cancelar", () => { this.closeConfirm(); }],
    ]);
    this.confirm = dialog;
    this.confirmButtons = elements;
  }

  // La mano del estudiante (eventos de verdad, aunque la pantalla no responda a los de la pagina).
  byHand = {
    openSubmenu: (login: string) => this.openSubmenu(login),
    signOutInSubmenu: () => this.askSignOut(this.submenuOwner),
    confirmSignOut: (login: string) => this.signOut(login),
    cancelConfirm: () => this.closeConfirm(),
  };

  signOut(login: string) {
    this.log.push(`signout:${login}`);
    this.accounts = this.accounts.filter((account) => account.login !== login);
    this.closeConfirm();
  }

  closeConfirm() {
    this.confirm?.remove();
    this.confirm = null;
  }
}
