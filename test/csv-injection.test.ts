import { describe, it, expect } from "vitest";
import Papa from "papaparse";
import { toCsv } from "../src/modules/exports/csv-out";

// Security: CSV/Excel formula-injection defense. A cell starting with = + - @ tab CR LF must be
// neutralized with a leading single-quote so spreadsheet apps treat it as text, not a formula.
// `src/modules/imports/csv-out.ts` is the same logic — covering one covers the shared behaviour.
// The sanitizer itself isn't exported, so we drive it through the public toCsv() entry point.

// Pull the value of `col` from the (single) data row of a CSV string. Round-trips through Papa
// so we read the *parsed* (un-escaped) value the way a spreadsheet would after honoring quoting.
function cellOf(csv: string, col: string): string | undefined {
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  return parsed.data[0]?.[col];
}

describe("csv formula-injection sanitizer (toCsv)", () => {
  // Every dangerous leading char the sanitizer guards: = + - @ tab CR LF.
  const dangerous: [name: string, raw: string][] = [
    ["equals", "=cmd|'/c calc'!A1"],
    ["plus", "+1+1"],
    ["minus", "-2+3"],
    ["at", "@SUM(A1)"],
    ["tab", "\tleading-tab"],
    ["carriage-return", "\rleading-cr"],
    ["line-feed", "\nleading-lf"],
  ];

  it.each(dangerous)("prefixes a leading %s with a single quote", (_name, raw) => {
    const csv = toCsv([{ full_name: raw }], ["full_name"]);
    // After parsing, the cell must START with the neutralizing quote + the original payload.
    expect(cellOf(csv, "full_name")).toBe(`'${raw}`);
  });

  it("does not touch a normal cell (no leading dangerous char)", () => {
    const csv = toCsv([{ full_name: "Alice Smith" }], ["full_name"]);
    expect(cellOf(csv, "full_name")).toBe("Alice Smith");
  });

  it("does not prefix a dangerous char that is NOT at the start", () => {
    // "a=b" is safe — the = isn't leading, so no quote is added.
    const csv = toCsv([{ full_name: "a=b+c@d" }], ["full_name"]);
    expect(cellOf(csv, "full_name")).toBe("a=b+c@d");
  });

  it("leaves non-string values (numbers/booleans) untouched", () => {
    const csv = toCsv([{ n: 42, b: true }], ["n", "b"]);
    expect(cellOf(csv, "n")).toBe("42");
    expect(cellOf(csv, "b")).toBe("true");
  });

  it("quotes/escapes commas, quotes and newlines per RFC 4180", () => {
    // Comma → field is wrapped in quotes; embedded " → doubled; newline → preserved inside quotes.
    const raw = 'Smith, John "JJ"\nSecond line';
    const csv = toCsv([{ note: raw }], ["note"]);
    // Raw CSV must contain the doubled quote escaping ("" inside the quoted field).
    expect(csv).toContain('""JJ""');
    // Round-tripped value is the exact original (quoting is transparent to a parser).
    expect(cellOf(csv, "note")).toBe(raw);
  });

  it("a malicious registrant fullName is neutralized end-to-end", () => {
    // Real attack shape: registrant types a formula as their name → admin opens export in Excel.
    const attack = "=HYPERLINK(\"http://evil\",\"click\")";
    const csv = toCsv([{ full_name: attack, email: "a@b.test" }], ["full_name", "email"]);
    expect(cellOf(csv, "full_name")).toBe(`'${attack}`); // disarmed
    expect(cellOf(csv, "email")).toBe("a@b.test"); // benign cell unchanged
  });

  it("emits a header-only line (CRLF) for an empty row set", () => {
    const csv = toCsv([], ["a", "b"]);
    expect(csv).toBe("a,b\r\n");
  });
});
