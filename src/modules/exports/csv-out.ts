import Papa from "papaparse";

// Neutralize CSV/Excel formula injection: prefix cells starting with = + - @ tab CR LF with a quote.
// LF (\n) included: some importers strip a leading newline then treat the following =/+/-/@ as a formula.
function escapeCell(v: unknown): unknown {
  if (typeof v === "string" && /^[=+\-@\t\r\n]/.test(v)) return `'${v}`;
  return v;
}
function sanitize(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) out[k] = escapeCell(v);
    return out;
  });
}

// Serialize flat objects → CSV text with an explicit, stable column order.
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  if (!rows.length) return columns.join(",") + "\r\n";
  return Papa.unparse(sanitize(rows), { columns });
}
