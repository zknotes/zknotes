import { describe, expect, test } from "vitest";
import { sanitizeHtml, sanitizeShareHtml } from "./dompurify";
import {
    applyImageWidthsFromAttr,
    applyPresentationFromAttrs,
    applyRowHeightsFromAttr,
    applyTablePropsFromAttr,
    applyTableWidthsFromAttr,
} from "./table-attrs";

function parse(html: string): Document {
    return new DOMParser().parseFromString(html, "text/html");
}

// What the editor serialises for a user-styled table and a resized image: the inline style for the
// live view, and the validated attributes the sanitiser lets through.
const EDITOR_HTML = `
<table style="width: 60%; --tbl-bw: 2px; --tbl-bs: dashed; --tbl-bc: #ff0000; --tbl-pad: 12px; background-color: #eeeeee"
       data-user-width="60%" data-tbl-bw="2" data-tbl-bs="dashed" data-tbl-bc="#ff0000" data-tbl-pad="12" data-tbl-bg="#eeeeee">
  <tbody><tr style="height: 48px" data-user-height="48px"><td>a</td></tr></tbody>
</table>
<img src="blob:x" width="640px" style="width:640px;height:auto;">
`;

describe("table-attrs — presentation rebuilt from validated attributes", () => {
    test("the export path: sanitizeHtml strips style, applyPresentationFromAttrs restores it", () => {
        const clean = sanitizeHtml(EDITOR_HTML);
        expect(clean).not.toContain("style=");

        const doc = parse(clean);
        applyPresentationFromAttrs(doc);

        const table = doc.querySelector("table") as HTMLElement;
        expect(table.style.width).toBe("60%");
        expect(table.style.getPropertyValue("--tbl-bw")).toBe("2px");
        expect(table.style.getPropertyValue("--tbl-bs")).toBe("dashed");
        expect(table.style.getPropertyValue("--tbl-bc")).toBe("#ff0000");
        expect(table.style.getPropertyValue("--tbl-pad")).toBe("12px");
        expect(table.style.backgroundColor).toBe("rgb(238, 238, 238)");

        const tr = doc.querySelector("tr") as HTMLElement;
        expect(tr.style.height).toBe("48px");

        const img = doc.querySelector("img") as HTMLElement;
        expect(img.style.width).toBe("640px");
        expect(img.style.height).toBe("auto");

        // The serialised result carries the rebuilt style — what ends up in the exported .html.
        expect(doc.body.innerHTML).toContain("width: 60%");
    });

    test("the share path uses the same attributes", () => {
        const doc = parse(sanitizeShareHtml(EDITOR_HTML));
        applyPresentationFromAttrs(doc);
        expect((doc.querySelector("table") as HTMLElement).style.width).toBe("60%");
        expect((doc.querySelector("tr") as HTMLElement).style.height).toBe("48px");
    });

    test("rejects values that are not the accepted shape (CSS injection through the attribute)", () => {
        const doc = parse(`
            <table data-user-width="1%;background:url(https://evil/x)" data-tbl-bg="url(https://evil/y)" data-tbl-bw="999" data-tbl-bs="expression(1)"><tbody><tr data-user-height="48px;color:red"><td>a</td></tr></tbody></table>
            <img width="1px;background:url(https://evil/z)">
        `);
        applyTableWidthsFromAttr(doc);
        applyRowHeightsFromAttr(doc);
        applyTablePropsFromAttr(doc);
        applyImageWidthsFromAttr(doc);

        const table = doc.querySelector("table") as HTMLElement;
        expect(table.getAttribute("style")).toBeNull();
        expect((doc.querySelector("tr") as HTMLElement).getAttribute("style")).toBeNull();
        expect((doc.querySelector("img") as HTMLElement).getAttribute("style")).toBeNull();
    });

    test("an image width in per cent is accepted, a bare number is not", () => {
        const doc = parse(`<img width="50%"><img width="640">`);
        applyImageWidthsFromAttr(doc);
        const [pct, bare] = Array.from(doc.querySelectorAll("img")) as HTMLElement[];
        expect(pct?.style.width).toBe("50%");
        expect(bare?.getAttribute("style")).toBeNull();
    });
});
