export type MenuId =
    | "heading"
    | "fontFamily"
    | "fontSize"
    | "color"
    | "highlight"
    | "table"
    | "tableTable"
    | "tableRow"
    | "tableColumn"
    | "tableCell"
    | "tablePicker"
    | "emoji"
    | "shortcuts"
    | "link"
    | "image"
    | "insert"
    | "textAlign";

export const TABLE_MENU_IDS: MenuId[] = [
    "table",
    "tableTable",
    "tableRow",
    "tableColumn",
    "tableCell",
];

export function isTableMenuOpen(menus: PopoverMenus): boolean {
    return menus.active !== null && TABLE_MENU_IDS.includes(menus.active);
}

export class PopoverMenus {
    active = $state<MenuId | null>(null);
    readonly #anchors = $state({} as Partial<Record<MenuId, HTMLElement>>);

    isOpen(id: MenuId): boolean {
        return this.active === id;
    }

    anchor(id: MenuId): HTMLElement | undefined {
        return this.#anchors[id];
    }

    toggle(id: MenuId, anchor?: HTMLElement): void {
        if (this.active === id) {
            this.active = null;
        } else {
            this.active = id;
            if (anchor) this.#anchors[id] = anchor;
        }
    }

    close(id: MenuId): void {
        if (this.active === id) this.active = null;
    }

    closeAll(): void {
        this.active = null;
    }
}
