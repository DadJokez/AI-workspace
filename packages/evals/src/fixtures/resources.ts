import type { Tool } from "@ai-workspace/agent";

/**
 * Production-shaped conversation-resource fixtures. The provider/tool name and
 * result receipts mirror apps/web/lib/conversation-resource-* so model evals
 * exercise the same contract as CSV/document uploads without needing Postgres.
 */
export const RESOURCE_QUERY_TOOL = "resources__query";

export const resourceFixtureIds = {
  revenueCsv: "resource-revenue-csv",
  inventoryCsv: "resource-inventory-csv",
  projectNotes: "resource-project-notes",
  partialNotes: "resource-partial-notes",
  missing: "resource-missing",
} as const;

export const revenueRows = [
  {
    customer: "Northstar Labs",
    revenue: "48217",
    segment: "Enterprise",
    status: "Active",
  },
  {
    customer: "Juniper Ridge",
    revenue: "13409",
    segment: "SMB",
    status: "At Risk",
  },
  {
    customer: "Meridian Health",
    revenue: "73006",
    segment: "Enterprise",
    status: "Active",
  },
  {
    customer: "Copper Finch",
    revenue: "9876",
    segment: "SMB",
    status: "Paused",
  },
] as const;

export const inventoryRows = [
  { sku: "VX-204", item: "Vision sensor", stock: "7", reorderPoint: "12" },
  { sku: "AX-019", item: "Armature kit", stock: "31", reorderPoint: "10" },
  { sku: "QZ-880", item: "Quartz relay", stock: "0", reorderPoint: "6" },
] as const;

export const projectNotes = [
  "Project Lighthouse operating review",
  "Owner: Priya Shah",
  "Launch date: 2026-09-17",
  "Approved budget: $284,500",
  "Decision: keep the beta limited to twelve design partners.",
  "Open risk: vendor security review is due 2026-08-29.",
].join("\n");

export const revenueTotal = revenueRows.reduce(
  (total, row) => total + Number(row.revenue),
  0,
);

type ResourceId = (typeof resourceFixtureIds)[keyof typeof resourceFixtureIds];

interface QueryInput {
  resourceId?: string;
  operation?: string;
  query?: string;
  position?: string;
  column?: string;
  aggregate?: string;
  filterColumn?: string;
  filterOperator?: string;
  filterValue?: string | number | boolean;
  sortColumn?: string;
  sortDirection?: string;
  limit?: number;
}

function receipt(
  resourceId: ResourceId,
  filename: string,
  operation: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    resourceId,
    filename,
    representation: filename.endsWith(".csv")
      ? "tabular_dataset"
      : "addressable_text",
    operation,
    lifecycleState: "available",
    sourceCoverage: "full",
    sourceBytes: 512,
    ...overrides,
  };
}

function rowsForFilter(
  rows: readonly Record<string, unknown>[],
  input: QueryInput,
): readonly Record<string, unknown>[] {
  if (!input.filterColumn || input.filterValue === undefined) return rows;
  const column = resolveColumn(rows, input.filterColumn);
  const expected = String(input.filterValue).toLowerCase();
  return rows.filter((row) => {
    const actual = String(row[column] ?? "").toLowerCase();
    switch (input.filterOperator) {
      case "contains":
        return actual.includes(expected);
      case "not_equals":
        return actual !== expected;
      default:
        return actual === expected;
    }
  });
}

function validateLegacyFilter(input: QueryInput, required: boolean): void {
  const hasAny =
    input.filterColumn !== undefined ||
    input.filterOperator !== undefined ||
    input.filterValue !== undefined;
  if (
    (required || hasAny) &&
    (!input.filterColumn ||
      !input.filterOperator ||
      input.filterValue === undefined)
  ) {
    throw new Error(
      "filterColumn, filterOperator, and filterValue are required.",
    );
  }
}

function filterMetadata(
  input: QueryInput,
  matchedRows: number,
): Record<string, unknown> {
  if (!input.filterColumn || input.filterValue === undefined) return {};
  const predicate = {
    column: input.filterColumn,
    operator: input.filterOperator ?? "equals",
    value: input.filterValue,
    comparison: "scalar",
  };
  return {
    matchedRows,
    filters: { logic: "and", predicates: [predicate] },
    filter: predicate,
  };
}

function resultLimit(value: number | undefined, fallback = 20): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(25, Math.floor(value)));
}

function modelVisibleRows(
  rows: readonly Record<string, unknown>[],
): Array<Record<string, string>> {
  return rows.map((row) => ({
    _sheet: "Data",
    ...Object.fromEntries(
      Object.entries(row).map(([column, value]) => [column, String(value)]),
    ),
  }));
}

function resolveColumn(
  rows: readonly Record<string, unknown>[],
  requested: string,
): string {
  const columns = Object.keys(rows[0] ?? {});
  const normalized = requested.trim().toLowerCase();
  const column = columns.find(
    (candidate) => candidate.trim().toLowerCase() === normalized,
  );
  if (!column) {
    throw new Error(
      `Column "${requested}" was not found in sheet "Data". Available: ${columns.join(", ")}.`,
    );
  }
  return column;
}

function queryTable(
  resourceId:
    | typeof resourceFixtureIds.revenueCsv
    | typeof resourceFixtureIds.inventoryCsv,
  filename: string,
  rows: readonly Record<string, unknown>[],
  input: QueryInput,
) {
  const operation = input.operation ?? "manifest";
  const columns = Object.keys(rows[0] ?? {});
  const baseReceipt = receipt(resourceId, filename, operation, {
    scannedRows: rows.length,
    scannedSheets: ["Data"],
  });
  if (operation === "manifest") {
    return {
      kind: "conversation_resource_result",
      receipt: receipt(resourceId, filename, operation, {
        sourceCoverage: "metadata_only",
        resultCoverage: "metadata_only",
      }),
      resource: {
        id: resourceId,
        filename,
        mimeType: "text/csv",
        kind: "spreadsheet",
        sizeBytes: 512,
        storageEncoding: "utf8",
      },
    };
  }
  if (operation === "table_schema") {
    return {
      kind: "conversation_resource_result",
      receipt: { ...baseReceipt, resultCoverage: "full" },
      sheets: [
        {
          name: "Data",
          rowCount: rows.length,
          totalColumns: columns.length,
          returnedColumns: { start: 0, end: columns.length },
          columns,
        },
      ],
    };
  }
  if (operation === "table_count") {
    return {
      kind: "conversation_resource_result",
      receipt: { ...baseReceipt, resultCoverage: "full" },
      rowCount: rows.length,
      bySheet: [{ sheet: "Data", rowCount: rows.length }],
    };
  }
  if (operation === "table_filter") {
    validateLegacyFilter(input, true);
    const filtered = rowsForFilter(rows, input);
    const limit = resultLimit(input.limit);
    const returned = filtered.slice(0, limit);
    return {
      kind: "conversation_resource_result",
      receipt: {
        ...baseReceipt,
        resultCoverage: filtered.length > returned.length ? "partial" : "full",
        ...filterMetadata(input, filtered.length),
        returnedRows: returned.length,
      },
      rows: modelVisibleRows(returned),
    };
  }
  if (operation === "table_sort") {
    if (!input.sortColumn) throw new Error("sortColumn is required.");
    const column = resolveColumn(rows, input.sortColumn);
    const direction = input.sortDirection === "desc" ? -1 : 1;
    const sorted = [...rows].sort((left, right) => {
      const a = left[column];
      const b = right[column];
      return direction * (Number(a) - Number(b) || String(a).localeCompare(String(b)));
    });
    const returned = sorted.slice(0, resultLimit(input.limit));
    return {
      kind: "conversation_resource_result",
      receipt: {
        ...baseReceipt,
        resultCoverage: sorted.length > returned.length ? "partial" : "full",
        sortedRows: sorted.length,
        returnedRows: returned.length,
      },
      rows: modelVisibleRows(returned),
    };
  }
  if (operation === "table_sample") {
    const position = input.position ?? "beginning";
    const limit = resultLimit(input.limit, 5);
    const start =
      position === "middle"
        ? Math.max(0, Math.floor((rows.length - limit) / 2))
        : position === "end"
          ? Math.max(0, rows.length - limit)
          : 0;
    const returned = rows.slice(start, start + limit);
    return {
      kind: "conversation_resource_result",
      receipt: { ...baseReceipt, resultCoverage: "partial" },
      samples: [
        {
          sheet: "Data",
          position,
          rowNumbers: {
            start: start + 2,
            end: start + returned.length + 1,
          },
          rows: modelVisibleRows(returned).map(({ _sheet, ...row }) => row),
        },
      ],
    };
  }
  if (operation === "table_aggregate") {
    validateLegacyFilter(input, false);
    const selected = rowsForFilter(rows, input);
    const aggregate = input.aggregate ?? "count";
    if (aggregate !== "count" && !input.column) {
      throw new Error("column is required for this aggregate.");
    }
    const requestedColumn = input.column;
    const column = requestedColumn
      ? resolveColumn(rows, requestedColumn)
      : undefined;
    const rawValues = column
      ? selected.map((row) => String(row[column] ?? ""))
      : [];
    const numericValues = rawValues
      .map((value) => Number(value.replace(/[$,%\s,]/g, "")))
      .filter((value) => Number.isFinite(value));
    if (
      column &&
      aggregate !== "count" &&
      aggregate !== "distinct_count" &&
      numericValues.length === 0
    ) {
      throw new Error(`Column "${column}" has no numeric values.`);
    }
    const value = !column
      ? selected.length
      : aggregate === "count"
        ? rawValues.filter(Boolean).length
        : aggregate === "distinct_count"
          ? new Set(rawValues).size
          : aggregate === "average"
            ? numericValues.reduce((sum, item) => sum + item, 0) /
              numericValues.length
            : aggregate === "min"
              ? Math.min(...numericValues)
              : aggregate === "max"
                ? Math.max(...numericValues)
                : numericValues.reduce((sum, item) => sum + item, 0);
    return {
      kind: "conversation_resource_result",
      receipt: {
        ...baseReceipt,
        resultCoverage: "full",
        ...filterMetadata(input, selected.length),
      },
      aggregate,
      ...(requestedColumn ? { column: requestedColumn } : {}),
      value,
      ...(column &&
      aggregate !== "count" &&
      aggregate !== "distinct_count"
        ? { numericValues: numericValues.length }
        : {}),
      ...(column ? { inspectedValues: rawValues.length } : {}),
    };
  }
  throw new Error(`Operation "${operation}" is not valid for tabular data.`);
}

function queryText(
  resourceId:
    | typeof resourceFixtureIds.projectNotes
    | typeof resourceFixtureIds.partialNotes,
  filename: string,
  content: string,
  input: QueryInput,
) {
  const operation = input.operation ?? "manifest";
  const partial = resourceId === resourceFixtureIds.partialNotes;
  const sourceCoverage = partial
    ? {
        lifecycleState: "partial",
        sourceCoverage: "partial",
        limitation:
          "Extraction stopped after page 1; later pages are unavailable.",
      }
    : {};
  const provenance = filename.endsWith(".pdf")
    ? ("page" as const)
    : ("character_range" as const);
  const location = filename.endsWith(".pdf")
    ? "page 1"
    : `characters 0-${content.length}`;
  const baseReceipt = receipt(resourceId, filename, operation, {
    ...sourceCoverage,
    extractable: true,
    sourceChars: content.length,
    sourceUnits: 1,
    provenance,
  });
  if (operation === "manifest") {
    return {
      kind: "conversation_resource_result",
      receipt: receipt(resourceId, filename, operation, {
        ...(partial ? { lifecycleState: "partial" } : {}),
        sourceCoverage: "metadata_only",
        resultCoverage: "metadata_only",
      }),
      resource: {
        id: resourceId,
        filename,
        mimeType: filename.endsWith(".pdf") ? "application/pdf" : "text/plain",
        kind: filename.endsWith(".pdf") ? "document" : "text",
        sizeBytes: 512,
        storageEncoding: "utf8",
      },
    };
  }
  if (operation !== "read" && operation !== "search") {
    throw new Error(`Operation "${operation}" is not valid for this document.`);
  }
  if (operation === "read") {
    const addressedContent = `${location}\n${content}`;
    return {
      kind: "conversation_resource_result",
      receipt: {
        ...baseReceipt,
        resultCoverage: "full",
        returnedCharacters: { start: 0, end: addressedContent.length },
      },
      content: addressedContent,
    };
  }

  const query = input.query?.trim();
  if (!query) throw new Error("query is required for search.");
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 1);
  const score = terms.filter((term) =>
    content.toLowerCase().includes(term),
  ).length;
  const matches =
    score > 0
      ? [{ location, score, text: content }]
      : [];
  return {
    kind: "conversation_resource_result",
    receipt: {
      ...baseReceipt,
      resultCoverage: "search_results",
      matchedSections: matches.length,
    },
    query,
    matches,
  };
}

export function createConversationResourceFixtureTool(): Tool {
  return {
    name: RESOURCE_QUERY_TOOL,
    description:
      "Read or analyze one authorized file from this conversation. For CSV use table operations that scan every row; for documents use read or search. Never guess from a filename or preview.",
    untrustedOutput: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["resourceId", "operation"],
      properties: {
        resourceId: { type: "string" },
        operation: {
          type: "string",
          enum: [
            "manifest",
            "read",
            "search",
            "table_schema",
            "table_count",
            "table_aggregate",
            "table_filter",
            "table_sort",
            "table_sample",
          ],
        },
        query: { type: "string" },
        position: { type: "string", enum: ["beginning", "middle", "end"] },
        column: { type: "string" },
        aggregate: {
          type: "string",
          enum: ["sum", "average", "min", "max", "count", "distinct_count"],
        },
        filterColumn: { type: "string" },
        filterOperator: {
          type: "string",
          enum: ["equals", "not_equals", "contains"],
        },
        filterValue: { type: ["string", "number", "boolean"] },
        sortColumn: { type: "string" },
        sortDirection: { type: "string", enum: ["asc", "desc"] },
        limit: { type: "number", minimum: 1, maximum: 100 },
      },
    },
    handler: async (rawInput) => {
      const input =
        typeof rawInput === "object" && rawInput !== null
          ? (rawInput as QueryInput)
          : {};
      switch (input.resourceId) {
        case resourceFixtureIds.revenueCsv:
          return queryTable(
            resourceFixtureIds.revenueCsv,
            "alpha-revenue.csv",
            revenueRows,
            input,
          );
        case resourceFixtureIds.inventoryCsv:
          return queryTable(
            resourceFixtureIds.inventoryCsv,
            "warehouse-inventory.csv",
            inventoryRows,
            input,
          );
        case resourceFixtureIds.projectNotes:
          return queryText(
            resourceFixtureIds.projectNotes,
            "project-lighthouse.txt",
            projectNotes,
            input,
          );
        case resourceFixtureIds.partialNotes:
          return queryText(
            resourceFixtureIds.partialNotes,
            "partial-board-notes.pdf",
            "Recovered from page 1: vote postponed pending legal review.",
            input,
          );
        case resourceFixtureIds.missing:
          throw new Error(
            "The conversation resource is unavailable or has been deleted.",
          );
        default:
          throw new Error(
            "That resource is not authorized for this conversation turn.",
          );
      }
    },
  };
}
