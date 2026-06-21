import { describe, it, expect } from "vitest";
import { validateAnswers, type FormSchema } from "../src/lib/form-schema";

// Unit suite for validateAnswers (src/lib/form-schema.ts). Pure — no DB.
// Covers every field-type branch + the two commented bug-fix branches (checkbox truthy-set,
// multiple_choice empty-as-missing/invalid-member) + allowMissingRequiredFiles relax option.

// Build a one-field schema for focused per-type assertions.
function schemaOf(field: FormSchema["fields"][number]): FormSchema {
  return { fields: [field] };
}

describe("validateAnswers — unknown keys", () => {
  it("rejects answer keys not present in the schema", () => {
    const schema = schemaOf({
      key: "name",
      type: "short_text",
      label: "Name",
      required: false,
      sort: 0,
    });
    const r = validateAnswers(schema, { name: "Ada", stray: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.stray).toBe("Unknown field");
  });
});

describe("validateAnswers — short_text required", () => {
  const schema = schemaOf({
    key: "name",
    type: "short_text",
    label: "Name",
    required: true,
    sort: 0,
  });

  it("errors when required value missing", () => {
    const r = validateAnswers(schema, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.name).toBe("Required");
  });

  it("accepts a provided string", () => {
    const r = validateAnswers(schema, { name: "Ada" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values.name).toBe("Ada");
  });

  it("rejects a non-string value", () => {
    const r = validateAnswers(schema, { name: 123 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.name).toBe("Must be text");
  });
});

describe("validateAnswers — number", () => {
  const schema = schemaOf({
    key: "age",
    type: "number",
    label: "Age",
    required: true,
    sort: 0,
  });

  it("coerces a numeric string to a number", () => {
    const r = validateAnswers(schema, { age: "42" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values.age).toBe(42);
  });

  it("passes through a real number", () => {
    const r = validateAnswers(schema, { age: 7 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values.age).toBe(7);
  });

  it("rejects a non-numeric string (NaN)", () => {
    const r = validateAnswers(schema, { age: "abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.age).toBe("Must be a number");
  });
});

describe("validateAnswers — checkbox (anti-Boolean('false') bug-fix branch)", () => {
  const schema = schemaOf({
    key: "agree",
    type: "checkbox",
    label: "Agree",
    required: false,
    sort: 0,
  });

  // The load-bearing branch: string "false" must NOT be treated as true.
  it("treats string 'false' as false (not Boolean('false') === true)", () => {
    const r = validateAnswers(schema, { agree: "false" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values.agree).toBe(false);
  });

  it("treats true / 1 / 'true' / '1' / 'on' as true", () => {
    for (const raw of [true, 1, "true", "1", "on"]) {
      const r = validateAnswers(schema, { agree: raw });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.values.agree).toBe(true);
    }
  });

  it("treats any other truthy-looking string as false", () => {
    const r = validateAnswers(schema, { agree: "yes" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values.agree).toBe(false);
  });
});

describe("validateAnswers — single_choice / dropdown", () => {
  for (const type of ["single_choice", "dropdown"] as const) {
    const schema = schemaOf({
      key: "color",
      type,
      label: "Color",
      required: true,
      sort: 0,
      options: ["red", "blue"],
    });

    it(`${type}: accepts a listed option`, () => {
      const r = validateAnswers(schema, { color: "red" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.values.color).toBe("red");
    });

    it(`${type}: rejects an option not in the list`, () => {
      const r = validateAnswers(schema, { color: "green" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.color).toBe("Invalid choice");
    });

    it(`${type}: rejects a non-string value`, () => {
      const r = validateAnswers(schema, { color: 1 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.color).toBe("Invalid choice");
    });
  }
});

describe("validateAnswers — multiple_choice (empty-as-missing + invalid-member bug-fix branch)", () => {
  const schema = schemaOf({
    key: "langs",
    type: "multiple_choice",
    label: "Languages",
    required: true,
    sort: 0,
    options: ["ts", "go", "rs"],
  });

  it("accepts an array of valid members", () => {
    const r = validateAnswers(schema, { langs: ["ts", "go"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values.langs).toEqual(["ts", "go"]);
  });

  // Empty array counts as missing → required fails (can't satisfy with zero selections).
  it("treats an empty array as missing for a required field", () => {
    const r = validateAnswers(schema, { langs: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.langs).toBe("Required");
  });

  it("rejects an array containing an option not in the list", () => {
    const r = validateAnswers(schema, { langs: ["ts", "java"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.langs).toBe("Invalid choices");
  });

  it("rejects an array containing a non-string member", () => {
    const r = validateAnswers(schema, { langs: ["ts", 5] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.langs).toBe("Invalid choices");
  });
});

describe("validateAnswers — file_upload", () => {
  const schema = schemaOf({
    key: "doc",
    type: "file_upload",
    label: "Document",
    required: true,
    sort: 0,
  });

  it("accepts a string file reference", () => {
    const r = validateAnswers(schema, { doc: "file-123" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values.doc).toBe("file-123");
  });

  it("rejects a non-string file reference", () => {
    const r = validateAnswers(schema, { doc: 999 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.doc).toBe("Invalid file reference");
  });
});

describe("validateAnswers — allowMissingRequiredFiles option", () => {
  // Two required fields: one file, one non-file. Both missing in the submission.
  const schema: FormSchema = {
    fields: [
      { key: "name", type: "short_text", label: "Name", required: true, sort: 0 },
      { key: "doc", type: "file_upload", label: "Doc", required: true, sort: 1 },
    ],
  };

  it("exempts only the required FILE field, still enforces the required non-file field", () => {
    const r = validateAnswers(schema, {}, { allowMissingRequiredFiles: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.doc).toBeUndefined(); // file exempt
      expect(r.errors.name).toBe("Required"); // non-file still enforced
    }
  });

  it("without the option, the required file field is enforced too", () => {
    const r = validateAnswers(schema, { name: "Ada" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.doc).toBe("Required");
  });
});
