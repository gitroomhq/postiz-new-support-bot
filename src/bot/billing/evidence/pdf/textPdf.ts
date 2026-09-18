// A minimal, dependency-free PDF writer for plain-text evidence documents.
//
// Why not a PDF library: this bot deploys without shell access and the two
// documents it needs to produce are a usage log and a support transcript, both
// of which are monospaced text and nothing else. A library would add a few
// megabytes of font machinery and a supply-chain surface to draw what fits in
// this file, and the output has to be reproducible: a bank may receive the same
// document twice and the two must be identical.
//
// Courier and Courier-Bold are two of the PDF base-14 fonts, so every reader
// has them and nothing is embedded. Monospace also makes wrapping exact rather
// than a measurement: every glyph is 0.6em, so a column count IS a width.

const PAGE_WIDTH = 595; // A4 at 72dpi
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const FONT_SIZE = 9;
const LINE_HEIGHT = 12;
const CHAR_WIDTH = FONT_SIZE * 0.6;

export const COLUMNS = Math.floor((PAGE_WIDTH - 2 * MARGIN) / CHAR_WIDTH);
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - 2 * MARGIN) / LINE_HEIGHT) - 1;

export interface PdfLine {
  text: string;
  bold?: boolean;
}

// PDF strings are Latin-1 here (WinAnsiEncoding), and the base-14 fonts have no
// glyphs beyond it. A character that cannot be represented is replaced rather
// than dropped: a silently shortened line in a bank's evidence is worse than a
// visible substitution.
function encodeText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    const safe = code >= 32 && code <= 126 ? ch : code >= 160 && code <= 255 ? ch : "?";
    if (safe === "(" || safe === ")" || safe === "\\") out += `\\${safe}`;
    else out += safe;
  }
  return out;
}

/** Hard-wrap to the page width, preferring word boundaries. Never truncates. */
export function wrap(text: string, columns = COLUMNS, indent = ""): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\t/g, "    ").trimEnd();
    if (!line) {
      out.push("");
      continue;
    }
    let rest = line;
    let prefix = "";
    while (rest.length > columns - prefix.length) {
      const room = columns - prefix.length;
      const slice = rest.slice(0, room + 1);
      const cut = slice.lastIndexOf(" ");
      // A word longer than the line gets broken: the alternative is a line that
      // runs off the page.
      const at = cut > room * 0.4 ? cut : room;
      out.push(prefix + rest.slice(0, at).trimEnd());
      rest = rest.slice(at).trimStart();
      prefix = indent;
    }
    out.push(prefix + rest);
  }
  return out;
}

/** Render lines to a PDF. Pages break automatically; the result is a Buffer. */
export function renderTextPdf(lines: PdfLine[]): Buffer {
  const pages: PdfLine[][] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));
  if (!pages.length) pages.push([]);

  // Object 1 catalog, 2 pages, 3 and 4 the fonts, then page/content pairs.
  const firstPageObj = 5;
  const kids = pages.map((_, i) => `${firstPageObj + i * 2} 0 R`).join(" ");
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>`,
  ];

  pages.forEach((page, index) => {
    const contentObj = firstPageObj + index * 2 + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObj} 0 R >>`
    );
    let stream = "BT\n";
    let y = PAGE_HEIGHT - MARGIN;
    let font = "";
    for (const line of page) {
      const want = line.bold ? "/F2" : "/F1";
      if (want !== font) {
        stream += `${want} ${FONT_SIZE} Tf\n`;
        font = want;
      }
      stream += `1 0 0 1 ${MARGIN} ${y} Tm (${encodeText(line.text)}) Tj\n`;
      y -= LINE_HEIGHT;
    }
    stream += "ET";
    objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  });

  // Assemble with a real xref table: a reader that cannot find an object here
  // shows a blank page, and nobody would notice until an analyst did.
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
