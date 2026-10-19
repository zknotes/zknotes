import {
    loadPersisted,
    rawStringSerde,
    removePersisted,
    savePersisted,
    STORAGE_KEYS,
} from "$lib/core/utils/persisted";
import { OUTLINE_MAX_WIDTH, OUTLINE_MIN_WIDTH } from "./outline-model";

export { OUTLINE_MAX_HEADING_LEVEL } from "./outline-model";

// A sticky panel, the way Word's navigation pane is: closed until you open it, then open on every
// note and after a reload until you close it again. One piece of state, no per-note copy, and
// nothing that opens by itself — a panel that appears while you are typing moves the text under the
// cursor, which is the part people actually objected to.
// Through the one localStorage wrapper; the stored format is unchanged ("1"/"0", a number string).
const VISIBLE_KEY = STORAGE_KEYS.outlineVisible;
const WIDTH_KEY = STORAGE_KEYS.outlineWidth;

const DEFAULT_WIDTH = 220;

function loadVisible(): boolean {
    return loadPersisted(VISIBLE_KEY, "0", rawStringSerde) === "1";
}

function loadWidth(): number {
    const v = Number(loadPersisted(WIDTH_KEY, "", rawStringSerde));
    return Number.isFinite(v) && v >= OUTLINE_MIN_WIDTH && v <= OUTLINE_MAX_WIDTH
        ? v
        : DEFAULT_WIDTH;
}

let visible = $state(loadVisible());
let width = $state(loadWidth());

function setVisible(v: boolean) {
    visible = v;
    savePersisted(VISIBLE_KEY, v ? "1" : "0", rawStringSerde);
}

export const outlineStore = {
    get visible() {
        return visible;
    },
    get width() {
        return width;
    },
    setWidth(px: number) {
        width = Math.max(OUTLINE_MIN_WIDTH, Math.min(OUTLINE_MAX_WIDTH, px));
        savePersisted(WIDTH_KEY, String(width), rawStringSerde);
    },

    /**
     * A transient change with no persistence — the mobile auto-hide after a heading is clicked.
     * It must not write the key: hiding the panel to get out of the way on a phone is not the user
     * saying they want it closed from now on.
     */
    setVisibleTransient(v: boolean) {
        visible = v;
    },

    toggle() {
        setVisible(!visible);
    },
    show() {
        setVisible(true);
    },
    hide() {
        setVisible(false);
    },

    /**
     * A reset on logout/delete account — the key is per-browser localStorage rather than
     * per-account, so without this a new or different account on the same device would inherit
     * someone else's panel state.
     */
    reset() {
        visible = false;
        removePersisted(VISIBLE_KEY);
    },
};
