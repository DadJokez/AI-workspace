import type { WorkspaceArtifact } from "@ai-workspace/db";

export type ConversationResourceArtifact = Pick<
  WorkspaceArtifact,
  | "id"
  | "filename"
  | "mimeType"
  | "kind"
  | "content"
  | "sizeBytes"
  | "metadata"
>;

export const RESOURCE_QUERY_OPERATIONS = [
  "manifest",
  "read",
  "search",
  "table_schema",
  "table_count",
  "table_aggregate",
  "table_filter",
  "table_sort",
  "table_sample",
] as const;

export type ResourceQueryOperation =
  (typeof RESOURCE_QUERY_OPERATIONS)[number];

export interface ConversationResourceQueryInput {
  resourceId: string;
  operation: ResourceQueryOperation;
  query?: string;
  position?: "beginning" | "middle" | "end";
  offset?: number;
  length?: number;
  sheet?: string;
  column?: string;
  aggregate?: "sum" | "average" | "min" | "max" | "count" | "distinct_count";
  filterColumn?: string;
  filterOperator?:
    | "equals"
    | "not_equals"
    | "contains"
    | "greater_than"
    | "greater_than_or_equal"
    | "less_than"
    | "less_than_or_equal";
  filterValue?: string | number | boolean;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
  limit?: number;
}

interface TextSection {
  location: string;
  text: string;
}

interface AddressableText {
  sections: TextSection[];
  sourceChars: number;
  sourceUnits: number;
  provenance: "character_range" | "page" | "paragraph" | "slide";
}

interface TabularSheet {
  name: string;
  rows: string[][];
}

interface TabularDataset {
  sheets: TabularSheet[];
}

type ResourceLifecycleState = "available" | "partial" | "extraction_failed";

const DEFAULT_TEXT_LENGTH = 8_000;
const MAX_TEXT_LENGTH = 16_000;
const DEFAULT_RESULT_LIMIT = 20;
const MAX_RESULT_LIMIT = 25;
const MAX_OUTPUT_COLUMNS = 25;
const MAX_CELL_CHARS = 250;

export async function queryConversationResource(
  resource: ConversationResourceArtifact,
  input: ConversationResourceQueryInput,
): Promise<Record<string, unknown>> {
  if (input.resourceId !== resource.id) {
    throw new Error("The requested resource does not match the authorized row.");
  }

  const lifecycleState = resourceLifecycleState(resource);
  const receipt = {
    resourceId: resource.id,
    filename: resource.filename,
    representation: representationForKind(resource.kind),
    operation: input.operation,
    lifecycleState,
    sourceCoverage:
      lifecycleState === "available" ? ("full" as const) : ("partial" as const),
    sourceBytes: resource.sizeBytes,
  };

  if (input.operation === "manifest") {
    return {
      kind: "conversation_resource_result",
      receipt: {
        ...receipt,
        sourceCoverage: "metadata_only",
        resultCoverage: "metadata_only",
      },
      resource: {
        id: resource.id,
        filename: resource.filename,
        mimeType: resource.mimeType,
        kind: resource.kind,
        sizeBytes: resource.sizeBytes,
        storageEncoding: storageEncoding(resource),
      },
    };
  }

  if (resource.kind === "spreadsheet") {
    const dataset = await extractTabularDataset(resource);
    return queryTabularDataset(dataset, input, receipt);
  }

  if (input.operation.startsWith("table_")) {
    throw new Error(
      `"${resource.filename}" is not tabular. Use read or search instead.`,
    );
  }

  if (resource.kind === "image") {
    return {
      kind: "conversation_resource_result",
      receipt: {
        ...receipt,
        representation: "native_image",
        resultCoverage: "metadata_only",
      },
      image: imageMetadata(resource),
      guidance:
        "The authorized original bytes are attached as native visual input on the selected chat turn. This tool exposes metadata only.",
    };
  }

  const document = await extractAddressableText(resource);
  const extractable =
    resource.kind === "text" || document.sourceUnits > 0;
  const documentReceipt = {
    ...receipt,
    sourceCoverage:
      lifecycleState === "available" && extractable ? "full" : "partial",
    extractable,
    ...(!extractable
      ? {
          limitation:
            "No extractable text was recovered from the stored file. Visual or scanned content may require OCR or native document vision.",
        }
      : lifecycleState !== "available"
        ? {
            limitation: `The resource lifecycle state is ${lifecycleState}; extracted results may be incomplete.`,
          }
        : {}),
  };
  if (input.operation === "search") {
    return searchAddressableText(document, input, documentReceipt);
  }
  if (input.operation !== "read") {
    throw new Error(`Operation "${input.operation}" is not valid for this file.`);
  }
  return readAddressableText(document, input, documentReceipt);
}

export function parseConversationResourceQueryInput(
  value: unknown,
): ConversationResourceQueryInput {
  if (!isRecord(value)) {
    throw new Error("Resource query arguments must be an object.");
  }
  if (typeof value.resourceId !== "string" || !value.resourceId.trim()) {
    throw new Error("resourceId is required.");
  }
  if (
    typeof value.operation !== "string" ||
    !(RESOURCE_QUERY_OPERATIONS as readonly string[]).includes(value.operation)
  ) {
    throw new Error(
      `operation must be one of: ${RESOURCE_QUERY_OPERATIONS.join(", ")}.`,
    );
  }
  return {
    resourceId: value.resourceId,
    operation: value.operation as ResourceQueryOperation,
    ...(typeof value.query === "string" ? { query: value.query } : {}),
    ...(value.position === "beginning" ||
    value.position === "middle" ||
    value.position === "end"
      ? { position: value.position }
      : {}),
    ...(finiteNumber(value.offset) !== null
      ? { offset: finiteNumber(value.offset)! }
      : {}),
    ...(finiteNumber(value.length) !== null
      ? { length: finiteNumber(value.length)! }
      : {}),
    ...(typeof value.sheet === "string" ? { sheet: value.sheet } : {}),
    ...(typeof value.column === "string" ? { column: value.column } : {}),
    ...(value.aggregate === "sum" ||
    value.aggregate === "average" ||
    value.aggregate === "min" ||
    value.aggregate === "max" ||
    value.aggregate === "count" ||
    value.aggregate === "distinct_count"
      ? { aggregate: value.aggregate }
      : {}),
    ...(typeof value.filterColumn === "string"
      ? { filterColumn: value.filterColumn }
      : {}),
    ...(value.filterOperator === "equals" ||
    value.filterOperator === "not_equals" ||
    value.filterOperator === "contains" ||
    value.filterOperator === "greater_than" ||
    value.filterOperator === "greater_than_or_equal" ||
    value.filterOperator === "less_than" ||
    value.filterOperator === "less_than_or_equal"
      ? { filterOperator: value.filterOperator }
      : {}),
    ...(typeof value.filterValue === "string" ||
    typeof value.filterValue === "number" ||
    typeof value.filterValue === "boolean"
      ? { filterValue: value.filterValue }
      : {}),
    ...(typeof value.sortColumn === "string"
      ? { sortColumn: value.sortColumn }
      : {}),
    ...(value.sortDirection === "asc" || value.sortDirection === "desc"
      ? { sortDirection: value.sortDirection }
      : {}),
    ...(finiteNumber(value.limit) !== null
      ? { limit: finiteNumber(value.limit)! }
      : {}),
  };
}

async function extractAddressableText(
  resource: ConversationResourceArtifact,
): Promise<AddressableText> {
  const extension = extensionOf(resource.filename);
  const buffer = resourceBuffer(resource);

  if (extension === "pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const parsed = await parser.getText();
      const text = parsed.text ?? "";
      const rawPages = splitPdfPages(text, parsed.total ?? 0);
      return textDocument(
        rawPages.map((page, index) => ({
          location: `page ${index + 1}`,
          text: page,
        })),
        "page",
      );
    } finally {
      await parser.destroy();
    }
  }

  if (extension === "docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    const paragraphs = result.value
      .split(/\n{2,}|\r?\n/)
      .map((text) => text.trim())
      .filter(Boolean);
    return textDocument(
      paragraphs.map((text, index) => ({
        location: `paragraph ${index + 1}`,
        text,
      })),
      "paragraph",
    );
  }

  if (extension === "pptx") {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buffer);
    const slideFiles = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((left, right) => slideNumber(left) - slideNumber(right));
    const sections: TextSection[] = [];
    for (const filename of slideFiles) {
      const xml = await zip.files[filename]?.async("text");
      if (!xml) continue;
      const text = Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g))
        .map((match) => decodeXml(match[1] ?? "").trim())
        .filter(Boolean)
        .join("\n");
      sections.push({
        location: `slide ${slideNumber(filename)}`,
        text,
      });
    }
    return textDocument(sections, "slide");
  }

  const text = buffer.toString("utf8");
  const sections = chunkText(text, 12_000).map((section) => ({
    location: `characters ${section.start}-${section.end}`,
    text: section.text,
  }));
  return textDocument(sections, "character_range");
}

async function extractTabularDataset(
  resource: ConversationResourceArtifact,
): Promise<TabularDataset> {
  const extension = extensionOf(resource.filename);
  const buffer = resourceBuffer(resource);
  if (extension === "xlsx") {
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    return {
      sheets: workbook.worksheets.map((sheet) => {
        const rows: string[][] = [];
        sheet.eachRow({ includeEmpty: true }, (row) => {
          const values: string[] = [];
          row.eachCell({ includeEmpty: true }, (cell) => {
            values.push(cell.text ?? "");
          });
          rows.push(trimTrailingEmpty(values));
        });
        return { name: sheet.name, rows: trimTrailingEmptyRows(rows) };
      }),
    };
  }

  const delimiter = extension === "tsv" ? "\t" : ",";
  return {
    sheets: [
      {
        name: "Data",
        rows: parseDelimited(buffer.toString("utf8"), delimiter),
      },
    ],
  };
}

function readAddressableText(
  document: AddressableText,
  input: ConversationResourceQueryInput,
  receipt: Record<string, unknown>,
): Record<string, unknown> {
  const joined = document.sections
    .map((section) => `${section.location}\n${section.text}`)
    .join("\n\n");
  const length = clampInteger(
    input.length,
    DEFAULT_TEXT_LENGTH,
    256,
    MAX_TEXT_LENGTH,
  );
  const requestedOffset =
    typeof input.offset === "number"
      ? clampInteger(input.offset, 0, 0, Math.max(0, joined.length - 1))
      : positionOffset(input.position ?? "beginning", joined.length, length);
  const start = Math.max(0, Math.min(requestedOffset, joined.length));
  const end = Math.min(joined.length, start + length);
  const content = joined.slice(start, end);
  return {
    kind: "conversation_resource_result",
    receipt: {
      ...receipt,
      resultCoverage:
        receipt.extractable === false
          ? "unavailable"
          : start === 0 && end >= joined.length
            ? "full"
            : "partial",
      sourceChars: document.sourceChars,
      sourceUnits: document.sourceUnits,
      provenance: document.provenance,
      returnedCharacters: { start, end },
    },
    content,
  };
}

function searchAddressableText(
  document: AddressableText,
  input: ConversationResourceQueryInput,
  receipt: Record<string, unknown>,
): Record<string, unknown> {
  const query = input.query?.trim();
  if (!query) throw new Error("query is required for search.");
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 1);
  const matches = document.sections
    .map((section) => ({
      section,
      score: scoreText(section.text, query, terms),
    }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, clampInteger(input.limit, 5, 1, 20))
    .map(({ section, score }) => ({
      location: section.location,
      score,
      text: excerptForQuery(section.text, query, terms),
    }));
  return {
    kind: "conversation_resource_result",
    receipt: {
      ...receipt,
      resultCoverage:
        receipt.extractable === false ? "unavailable" : "search_results",
      sourceChars: document.sourceChars,
      sourceUnits: document.sourceUnits,
      provenance: document.provenance,
      matchedSections: matches.length,
    },
    query,
    matches,
  };
}

function queryTabularDataset(
  dataset: TabularDataset,
  input: ConversationResourceQueryInput,
  receipt: Record<string, unknown>,
): Record<string, unknown> {
  const sheets = selectSheets(dataset, input.sheet);
  const scannedRows = sheets.reduce(
    (total, sheet) => total + Math.max(0, sheet.rows.length - 1),
    0,
  );
  const baseReceipt = {
    ...receipt,
    representation: "tabular_dataset",
    scannedRows,
    scannedSheets: sheets.map((sheet) => sheet.name),
  };

  if (input.operation === "table_schema") {
    const columnOffset = clampInteger(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const columnLimit = clampInteger(
      input.limit,
      MAX_OUTPUT_COLUMNS,
      1,
      100,
    );
    const schemas = sheets.map((sheet) => {
      const columns = headerForSheet(sheet);
      const start = Math.min(columnOffset, columns.length);
      return {
        name: sheet.name,
        rowCount: Math.max(0, sheet.rows.length - 1),
        totalColumns: columns.length,
        returnedColumns: {
          start,
          end: Math.min(columns.length, start + columnLimit),
        },
        columns: columns
          .slice(start, start + columnLimit)
          .map(boundedCell),
      };
    });
    return {
      kind: "conversation_resource_result",
      receipt: {
        ...baseReceipt,
        resultCoverage: schemas.every(
          (schema) => schema.returnedColumns.end >= schema.totalColumns,
        )
          ? "full"
          : "partial",
      },
      sheets: schemas,
    };
  }

  if (input.operation === "table_count") {
    return {
      kind: "conversation_resource_result",
      receipt: { ...baseReceipt, resultCoverage: "full" },
      rowCount: scannedRows,
      bySheet: sheets.map((sheet) => ({
        sheet: sheet.name,
        rowCount: Math.max(0, sheet.rows.length - 1),
      })),
    };
  }

  if (input.operation === "table_aggregate") {
    return aggregateDataset(sheets, input, baseReceipt);
  }
  if (input.operation === "table_filter") {
    return filterDataset(sheets, input, baseReceipt);
  }
  if (input.operation === "table_sort") {
    return sortDataset(sheets, input, baseReceipt);
  }
  if (input.operation === "table_sample") {
    return sampleDataset(sheets, input, baseReceipt);
  }
  if (input.operation === "manifest") {
    return {
      kind: "conversation_resource_result",
      receipt: { ...baseReceipt, resultCoverage: "full" },
    };
  }
  throw new Error(
    `Operation "${input.operation}" is not valid for a tabular resource.`,
  );
}

function aggregateDataset(
  sheets: readonly TabularSheet[],
  input: ConversationResourceQueryInput,
  receipt: Record<string, unknown>,
): Record<string, unknown> {
  if (
    input.filterColumn !== undefined ||
    input.filterOperator !== undefined ||
    input.filterValue !== undefined
  ) {
    throw new Error(
      "Filtered aggregation is not supported yet. Use table_filter to inspect matching rows; table_aggregate will not return an unfiltered value for a filtered request.",
    );
  }

  const aggregate = input.aggregate ?? "count";
  if (aggregate === "count" && !input.column) {
    const value = sheets.reduce(
      (total, sheet) => total + Math.max(0, sheet.rows.length - 1),
      0,
    );
    return {
      kind: "conversation_resource_result",
      receipt: { ...receipt, resultCoverage: "full" },
      aggregate,
      value,
    };
  }
  if (!input.column) {
    throw new Error("column is required for this aggregate.");
  }

  const values: string[] = [];
  for (const sheet of sheets) {
    const index = columnIndex(sheet, input.column);
    for (const row of sheet.rows.slice(1)) values.push(row[index] ?? "");
  }
  if (aggregate === "distinct_count") {
    return {
      kind: "conversation_resource_result",
      receipt: { ...receipt, resultCoverage: "full" },
      aggregate,
      column: input.column,
      value: new Set(values).size,
      inspectedValues: values.length,
    };
  }
  if (aggregate === "count") {
    return {
      kind: "conversation_resource_result",
      receipt: { ...receipt, resultCoverage: "full" },
      aggregate,
      column: input.column,
      value: values.filter((value) => value !== "").length,
      inspectedValues: values.length,
    };
  }
  const numbers = values.map(parseNumericCell).filter(isFiniteNumber);
  if (numbers.length === 0) {
    throw new Error(`Column "${input.column}" has no numeric values.`);
  }
  const value =
    aggregate === "sum"
      ? numbers.reduce((sum, number) => sum + number, 0)
      : aggregate === "average"
        ? numbers.reduce((sum, number) => sum + number, 0) / numbers.length
        : numbers.reduce(
            (current, number) =>
              aggregate === "min"
                ? Math.min(current, number)
                : Math.max(current, number),
            numbers[0]!,
          );
  return {
    kind: "conversation_resource_result",
    receipt: { ...receipt, resultCoverage: "full" },
    aggregate,
    column: input.column,
    value,
    numericValues: numbers.length,
    inspectedValues: values.length,
  };
}

function filterDataset(
  sheets: readonly TabularSheet[],
  input: ConversationResourceQueryInput,
  receipt: Record<string, unknown>,
): Record<string, unknown> {
  if (
    !input.filterColumn ||
    !input.filterOperator ||
    input.filterValue === undefined
  ) {
    throw new Error(
      "filterColumn, filterOperator, and filterValue are required.",
    );
  }
  const limit = clampInteger(
    input.limit,
    DEFAULT_RESULT_LIMIT,
    1,
    MAX_RESULT_LIMIT,
  );
  const rows: Array<Record<string, string>> = [];
  let matchedRows = 0;
  for (const sheet of sheets) {
    const headers = headerForSheet(sheet);
    const index = columnIndex(sheet, input.filterColumn);
    for (const row of sheet.rows.slice(1)) {
      if (
        compareFilter(
          row[index] ?? "",
          input.filterOperator,
          input.filterValue,
        )
      ) {
        matchedRows += 1;
        if (rows.length < limit) {
          rows.push({
            _sheet: sheet.name,
            ...rowAsRecord(headers, row, [index]),
          });
        }
      }
    }
  }
  return {
    kind: "conversation_resource_result",
    receipt: {
      ...receipt,
      resultCoverage: matchedRows > rows.length ? "partial" : "full",
      matchedRows,
      returnedRows: rows.length,
    },
    rows,
  };
}

function sortDataset(
  sheets: readonly TabularSheet[],
  input: ConversationResourceQueryInput,
  receipt: Record<string, unknown>,
): Record<string, unknown> {
  if (!input.sortColumn) throw new Error("sortColumn is required.");
  const limit = clampInteger(
    input.limit,
    DEFAULT_RESULT_LIMIT,
    1,
    MAX_RESULT_LIMIT,
  );
  const sortable: Array<{
    sheet: string;
    headers: string[];
    row: string[];
    value: string;
    sortColumnIndex: number;
  }> = [];
  for (const sheet of sheets) {
    const headers = headerForSheet(sheet);
    const index = columnIndex(sheet, input.sortColumn);
    for (const row of sheet.rows.slice(1)) {
      sortable.push({
        sheet: sheet.name,
        headers,
        row,
        value: row[index] ?? "",
        sortColumnIndex: index,
      });
    }
  }
  const direction = input.sortDirection === "desc" ? -1 : 1;
  sortable.sort(
    (left, right) => compareCells(left.value, right.value) * direction,
  );
  const rows = sortable.slice(0, limit).map((item) => ({
    _sheet: item.sheet,
    ...rowAsRecord(item.headers, item.row, [item.sortColumnIndex]),
  }));
  return {
    kind: "conversation_resource_result",
    receipt: {
      ...receipt,
      resultCoverage: sortable.length > rows.length ? "partial" : "full",
      sortedRows: sortable.length,
      returnedRows: rows.length,
    },
    rows,
  };
}

function sampleDataset(
  sheets: readonly TabularSheet[],
  input: ConversationResourceQueryInput,
  receipt: Record<string, unknown>,
): Record<string, unknown> {
  const position = input.position ?? "beginning";
  const limit = clampInteger(input.limit, 5, 1, 25);
  const samples = sheets.map((sheet) => {
    const headers = headerForSheet(sheet);
    const rows = sheet.rows.slice(1);
    const start =
      position === "middle"
        ? Math.max(0, Math.floor((rows.length - limit) / 2))
        : position === "end"
          ? Math.max(0, rows.length - limit)
          : 0;
    return {
      sheet: sheet.name,
      position,
      rowNumbers: {
        start: start + 2,
        end: start + 1 + Math.min(limit, Math.max(0, rows.length - start)),
      },
      rows: rows.slice(start, start + limit).map((row) =>
        rowAsRecord(headers, row),
      ),
    };
  });
  return {
    kind: "conversation_resource_result",
    receipt: { ...receipt, resultCoverage: "partial" },
    samples,
  };
}

function textDocument(
  sections: TextSection[],
  provenance: AddressableText["provenance"],
): AddressableText {
  const normalized = sections.filter((section) => section.text.trim());
  return {
    sections: normalized,
    sourceChars: normalized.reduce(
      (total, section) => total + section.text.length,
      0,
    ),
    sourceUnits: normalized.length,
    provenance,
  };
}

function splitPdfPages(text: string, totalPages: number): string[] {
  const formFeed = text.split("\f").map((page) => page.trim()).filter(Boolean);
  if (formFeed.length > 1) return formFeed;
  const pageMarker = /-{2,}\s*\d+\s+of\s+\d+\s*-{2,}/i;
  const marked = text
    .split(pageMarker)
    .map((page) => page.trim())
    .filter(Boolean);
  if (pageMarker.test(text)) return marked;
  if (totalPages > 1 && text.length > 0) {
    const pageSize = Math.ceil(text.length / totalPages);
    return Array.from({ length: totalPages }, (_, index) =>
      text.slice(index * pageSize, (index + 1) * pageSize).trim(),
    );
  }
  return [text.trim()];
}

function chunkText(text: string, chunkSize: number) {
  const chunks: Array<{ start: number; end: number; text: string }> = [];
  for (let start = 0; start < text.length; start += chunkSize) {
    const end = Math.min(text.length, start + chunkSize);
    chunks.push({ start, end, text: text.slice(start, end) });
  }
  return chunks;
}

function scoreText(text: string, query: string, terms: readonly string[]): number {
  const haystack = text.toLowerCase();
  const phrase = query.toLowerCase();
  let score = haystack.includes(phrase) ? 100 : 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

function excerptForQuery(
  text: string,
  query: string,
  terms: readonly string[],
): string {
  const haystack = text.toLowerCase();
  const phraseIndex = haystack.indexOf(query.toLowerCase());
  const termIndex =
    phraseIndex >= 0
      ? phraseIndex
      : terms
          .map((term) => haystack.indexOf(term))
          .filter((index) => index >= 0)
          .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, termIndex - 1_500);
  return text.slice(start, start + 4_000);
}

function selectSheets(
  dataset: TabularDataset,
  requested: string | undefined,
): TabularSheet[] {
  if (!requested) return dataset.sheets;
  const normalized = requested.trim().toLowerCase();
  const matches = dataset.sheets.filter(
    (sheet) => sheet.name.toLowerCase() === normalized,
  );
  if (matches.length === 0) {
    throw new Error(
      `Sheet "${requested}" was not found. Available: ${dataset.sheets
        .map((sheet) => sheet.name)
        .join(", ")}.`,
    );
  }
  return matches;
}

function headerForSheet(sheet: TabularSheet): string[] {
  const first = sheet.rows[0] ?? [];
  const width = sheet.rows.reduce(
    (current, row) => Math.max(current, row.length),
    first.length,
  );
  return Array.from({ length: width }, (_, index) => {
    const value = first[index]?.trim();
    return value || `column_${index + 1}`;
  });
}

function columnIndex(sheet: TabularSheet, requested: string): number {
  const headers = headerForSheet(sheet);
  const normalized = requested.trim().toLowerCase();
  const index = headers.findIndex(
    (header) => header.trim().toLowerCase() === normalized,
  );
  if (index < 0) {
    throw new Error(
      `Column "${requested}" was not found in sheet "${sheet.name}". Available: ${headers.join(", ")}.`,
    );
  }
  return index;
}

function rowAsRecord(
  headers: readonly string[],
  row: readonly string[],
  requiredColumnIndexes: readonly number[] = [],
): Record<string, string> {
  const indexes = Array.from(
    new Set([
      ...requiredColumnIndexes.filter(
        (index) => index >= 0 && index < headers.length,
      ),
      ...Array.from(
        { length: Math.min(headers.length, MAX_OUTPUT_COLUMNS) },
        (_value, index) => index,
      ),
    ]),
  ).slice(0, MAX_OUTPUT_COLUMNS);
  return Object.fromEntries([
    ...indexes.map((index) => [
      boundedCell(headers[index] ?? `column_${index + 1}`),
      boundedCell(row[index] ?? ""),
    ]),
    ...(headers.length > indexes.length
      ? [["_omittedColumns", String(headers.length - indexes.length)]]
      : []),
  ]);
}

function compareFilter(
  actual: string,
  operator: NonNullable<ConversationResourceQueryInput["filterOperator"]>,
  expected: string | number | boolean,
): boolean {
  if (
    typeof expected === "boolean" &&
    operator !== "equals" &&
    operator !== "not_equals"
  ) {
    throw new Error(
      "Boolean filter values support only equals or not_equals.",
    );
  }

  const numericActual = parseNumericCell(actual);
  const numericExpected =
    typeof expected === "number"
      ? expected
      : typeof expected === "string"
        ? parseNumericCell(expected)
        : Number.NaN;
  const numeric =
    Number.isFinite(numericActual) && Number.isFinite(numericExpected);
  const left = numeric ? numericActual : actual.toLowerCase();
  const right = numeric ? numericExpected : String(expected).toLowerCase();
  if (operator === "equals") return left === right;
  if (operator === "not_equals") return left !== right;
  if (operator === "contains") {
    return String(left).includes(String(right));
  }
  if (operator === "greater_than") return left > right;
  if (operator === "greater_than_or_equal") return left >= right;
  if (operator === "less_than") return left < right;
  return left <= right;
}

function compareCells(left: string, right: string): number {
  const numericLeft = parseNumericCell(left);
  const numericRight = parseNumericCell(right);
  if (Number.isFinite(numericLeft) && Number.isFinite(numericRight)) {
    return numericLeft - numericRight;
  }
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function parseNumericCell(value: string): number {
  const normalized = value.replace(/[$,%\s,]/g, "");
  if (!normalized) return Number.NaN;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : Number.NaN;
}

function parseDelimited(input: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function resourceBuffer(resource: ConversationResourceArtifact): Buffer {
  return storageEncoding(resource) === "base64"
    ? Buffer.from(resource.content, "base64")
    : Buffer.from(resource.content, "utf8");
}

function storageEncoding(
  resource: ConversationResourceArtifact,
): "base64" | "utf8" {
  const metadata = isRecord(resource.metadata) ? resource.metadata : null;
  return metadata?.storageEncoding === "base64" ? "base64" : "utf8";
}

function resourceLifecycleState(
  resource: ConversationResourceArtifact,
): ResourceLifecycleState {
  const metadata = isRecord(resource.metadata) ? resource.metadata : null;
  const resourceMetadata = isRecord(metadata?.conversationResource)
    ? metadata.conversationResource
    : null;
  const lifecycleState = resourceMetadata?.lifecycleState;
  if (
    lifecycleState === "available" ||
    lifecycleState === "partial" ||
    lifecycleState === "extraction_failed"
  ) {
    return lifecycleState;
  }
  return metadata?.extractionStatus === "metadata_only" &&
    resource.kind !== "image"
    ? "partial"
    : "available";
}

function imageMetadata(
  resource: ConversationResourceArtifact,
): Record<string, unknown> {
  const metadata = isRecord(resource.metadata) ? resource.metadata : null;
  const image = isRecord(metadata?.image) ? metadata.image : null;
  return {
    mimeType: resource.mimeType,
    sizeBytes: resource.sizeBytes,
    ...(typeof image?.width === "number" ? { width: image.width } : {}),
    ...(typeof image?.height === "number" ? { height: image.height } : {}),
  };
}

function representationForKind(kind: string): string {
  if (kind === "spreadsheet") return "tabular_dataset";
  if (kind === "image") return "native_image";
  return "addressable_text";
}

function positionOffset(
  position: "beginning" | "middle" | "end",
  total: number,
  length: number,
): number {
  if (position === "middle") return Math.max(0, Math.floor((total - length) / 2));
  if (position === "end") return Math.max(0, total - length);
  return 0;
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedCell(value: string): string {
  return value.slice(0, MAX_CELL_CHARS);
}

function trimTrailingEmpty(values: string[]): string[] {
  let end = values.length;
  while (end > 0 && !values[end - 1]) end -= 1;
  return values.slice(0, end);
}

function trimTrailingEmptyRows(rows: string[][]): string[][] {
  let end = rows.length;
  while (end > 0 && rows[end - 1]?.every((value) => !value)) end -= 1;
  return rows.slice(0, end);
}

function extensionOf(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function slideNumber(filename: string): number {
  const match = /slide(\d+)\.xml$/.exec(filename);
  return match?.[1] ? Number.parseInt(match[1], 10) : 0;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
