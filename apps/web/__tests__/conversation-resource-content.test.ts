import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  parseConversationResourceQueryInput,
  queryConversationResource,
  type ConversationResourceArtifact,
} from "@/lib/conversation-resource-content";

describe.sequential("complete conversation resource adapters (#576)", () => {
  it("reads facts from the beginning, middle, and end of complete long text", async () => {
    const text = [
      "BEGIN_FACT=albatross",
      "a".repeat(30_000),
      "MIDDLE_FACT=bluejay",
      "b".repeat(30_000),
      "END_FACT=cardinal",
    ].join("\n");
    const resource = textResource("facts.txt", text);

    const beginning = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "read",
      position: "beginning",
      length: 16_000,
    });
    const middle = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "read",
      position: "middle",
      length: 16_000,
    });
    const end = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "read",
      position: "end",
      length: 16_000,
    });

    expect(beginning.content).toContain("BEGIN_FACT=albatross");
    expect(middle.content).toContain("MIDDLE_FACT=bluejay");
    expect(end.content).toContain("END_FACT=cardinal");
    expect(beginning.receipt).toMatchObject({
      sourceCoverage: "full",
      resultCoverage: "partial",
      provenance: "character_range",
    });
  });

  it.each([
    { extension: "csv", delimiter: "," },
    { extension: "tsv", delimiter: "\t" },
  ])(
    "scans every row for deterministic .$extension counts, aggregates, filters, and samples",
    async ({ extension, delimiter }) => {
      const rows = Array.from({ length: 300 }, (_, index) => {
        const ordinal = index + 1;
        const marker =
          ordinal === 1
            ? "BEGIN_TABLE_FACT"
            : ordinal === 150
              ? "MIDDLE_TABLE_FACT"
              : ordinal === 300
                ? "END_TABLE_FACT"
                : "";
        return [String(ordinal), String(ordinal), marker].join(delimiter);
      });
      const resource = textResource(
        `facts.${extension}`,
        [`id${delimiter}amount${delimiter}marker`, ...rows].join("\n"),
        "spreadsheet",
      );

      const count = await queryConversationResource(resource, {
        resourceId: resource.id,
        operation: "table_count",
      });
      const aggregate = await queryConversationResource(resource, {
        resourceId: resource.id,
        operation: "table_aggregate",
        column: "amount",
        aggregate: "sum",
      });
      const middle = await queryConversationResource(resource, {
        resourceId: resource.id,
        operation: "table_filter",
        filterColumn: "marker",
        filterOperator: "contains",
        filterValue: "MIDDLE_TABLE_FACT",
      });
      const end = await queryConversationResource(resource, {
        resourceId: resource.id,
        operation: "table_sample",
        position: "end",
        limit: 2,
      });

      expect(count).toMatchObject({
        rowCount: 300,
        receipt: { sourceCoverage: "full", scannedRows: 300 },
      });
      expect(aggregate).toMatchObject({
        aggregate: "sum",
        value: 45_150,
        numericValues: 300,
        receipt: { resultCoverage: "full", scannedRows: 300 },
      });
      expect(JSON.stringify(middle)).toContain("MIDDLE_TABLE_FACT");
      expect(JSON.stringify(end)).toContain("END_TABLE_FACT");
    },
  );

  it("computes filtered aggregates over only the matching rows", async () => {
    const resource = textResource(
      "orders.csv",
      [
        "order_id,discount_pct,sales_rep,order_date",
        "1,17,Dana Kim,2024-01-10",
        "2,18,Dana Kim,2024-01-20",
        "3,0,Other Rep,2024-02-10",
        "4,1,Other Rep,2024-02-20",
      ].join("\n"),
      "spreadsheet",
    );

    await expect(
      queryConversationResource(resource, {
        resourceId: resource.id,
        operation: "table_aggregate",
        aggregate: "count",
        filterColumn: "order_date",
        filterOperator: "contains",
        filterValue: "2024-01",
      }),
    ).resolves.toMatchObject({
      aggregate: "count",
      value: 2,
      receipt: {
        scannedRows: 4,
        matchedRows: 2,
        resultCoverage: "full",
      },
    });

    await expect(
      queryConversationResource(resource, {
        resourceId: resource.id,
        operation: "table_aggregate",
        column: "discount_pct",
        aggregate: "average",
        filterColumn: "sales_rep",
        filterOperator: "equals",
        filterValue: "Dana Kim",
      }),
    ).resolves.toMatchObject({
      aggregate: "average",
      column: "discount_pct",
      value: 17.5,
      numericValues: 2,
      inspectedValues: 2,
      receipt: {
        scannedRows: 4,
        matchedRows: 2,
        filters: {
          logic: "and",
          predicates: [
            {
              column: "sales_rep",
              operator: "equals",
              value: "Dana Kim",
              comparison: "scalar",
            },
          ],
        },
      },
    });
  });

  it("supports up to three compound AND/OR predicates", async () => {
    const resource = textResource(
      "orders.csv",
      [
        "id,sales_rep,discount_pct,refunded,region",
        "1,Dana,20,TRUE,East",
        "2,Dana,10,TRUE,West",
        "3,Dana,25,FALSE,West",
        "4,Lee,30,TRUE,East",
        "5,Lee,5,FALSE,West",
      ].join("\n"),
      "spreadsheet",
    );

    const andResult = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "table_aggregate",
      aggregate: "count",
      filters: [
        { column: "sales_rep", operator: "equals", value: "Dana" },
        {
          column: "discount_pct",
          operator: "greater_than",
          value: 15,
        },
        { column: "refunded", operator: "equals", value: true },
      ],
    });
    const orResult = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "table_filter",
      filterLogic: "or",
      filters: [
        { column: "region", operator: "equals", value: "East" },
        { column: "refunded", operator: "equals", value: true },
      ],
    });

    expect(andResult).toMatchObject({
      value: 1,
      receipt: {
        scannedRows: 5,
        matchedRows: 1,
        filters: { logic: "and" },
      },
    });
    expect(orResult).toMatchObject({
      receipt: {
        scannedRows: 5,
        matchedRows: 3,
        returnedRows: 3,
        filters: { logic: "or" },
      },
    });
    expect(orResult.rows).toEqual([
      expect.objectContaining({ id: "1" }),
      expect.objectContaining({ id: "2" }),
      expect.objectContaining({ id: "4" }),
    ]);
  });

  it("returns truthful empty filtered aggregates and rejects filters on table_count", async () => {
    const resource = textResource(
      "orders.csv",
      ["id,status,amount", "1,open,10", "2,closed,20"].join("\n"),
      "spreadsheet",
    );
    const filters = [
      { column: "status", operator: "equals" as const, value: "missing" },
    ];

    await expect(
      queryConversationResource(resource, {
        resourceId: resource.id,
        operation: "table_aggregate",
        aggregate: "average",
        column: "amount",
        filters,
      }),
    ).resolves.toMatchObject({
      value: null,
      numericValues: 0,
      inspectedValues: 0,
      receipt: { scannedRows: 2, matchedRows: 0, resultCoverage: "full" },
    });
    await expect(
      queryConversationResource(resource, {
        resourceId: resource.id,
        operation: "table_count",
        filters,
      }),
    ).rejects.toThrow(/only for table_filter or table_aggregate/i);
  });

  it("groups filtered aggregates by a single column", async () => {
    const resource = textResource(
      "orders.csv",
      [
        "id,category,amount,order_date",
        "1,A,10,2024-01-01",
        "2,A,20,2024-01-06",
        "3,B,30,2024-02-01",
        "4,A,40,2024-04-01",
        "5,B,50,2025-01-01",
      ].join("\n"),
      "spreadsheet",
    );

    const result = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "table_aggregate",
      column: "amount",
      aggregate: "sum",
      groupByColumn: "category",
      filters: [
        {
          column: "order_date",
          operator: "greater_than_or_equal",
          value: "2024-01-01",
        },
        {
          column: "order_date",
          operator: "less_than",
          value: "2025-01-01",
        },
      ],
    });

    expect(result).toMatchObject({
      aggregate: "sum",
      column: "amount",
      groupBy: { column: "category" },
      receipt: {
        scannedRows: 5,
        matchedRows: 4,
        groupedRows: 4,
        totalGroups: 2,
        returnedGroups: 2,
        resultCoverage: "full",
      },
      groups: [
        {
          key: "A",
          rowCount: 3,
          value: 70,
          numericValues: 3,
          inspectedValues: 3,
        },
        {
          key: "B",
          rowCount: 1,
          value: 30,
          numericValues: 1,
          inspectedValues: 1,
        },
      ],
    });
  });

  it("bounds high-cardinality grouped output while retaining full scan counts", async () => {
    const resource = textResource(
      "groups.csv",
      [
        "id,segment",
        ...Array.from({ length: 105 }, (_, index) =>
          `${index + 1},segment-${String(index + 1).padStart(3, "0")}`,
        ),
      ].join("\n"),
      "spreadsheet",
    );

    const result = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "table_aggregate",
      aggregate: "count",
      groupByColumn: "segment",
      limit: 3,
    });

    expect(result).toMatchObject({
      receipt: {
        scannedRows: 105,
        groupedRows: 105,
        totalGroups: 105,
        returnedGroups: 3,
        resultCoverage: "partial",
      },
      groups: [
        { key: "segment-001", value: 1 },
        { key: "segment-002", value: 1 },
        { key: "segment-003", value: 1 },
      ],
    });
  });

  it("derives complete calendar groups from mixed-format dates", async () => {
    const resource = textResource(
      "orders.csv",
      [
        "id,order_date",
        "1,2024-01-01",
        "2,1/6/2024",
        "3,2024-02-01",
        "4,4/1/2024",
        "5,2025-01-01",
        "6,not-a-date",
      ].join("\n"),
      "spreadsheet",
    );
    const expected = {
      year: [
        { key: "2024", value: 4 },
        { key: "2025", value: 1 },
      ],
      quarter: [
        { key: "2024-Q1", value: 3 },
        { key: "2024-Q2", value: 1 },
        { key: "2025-Q1", value: 1 },
      ],
      month: [
        { key: "2024-01", value: 2 },
        { key: "2024-02", value: 1 },
        { key: "2024-04", value: 1 },
        { key: "2025-01", value: 1 },
      ],
      week: [
        { key: "2024-W01", value: 2 },
        { key: "2024-W05", value: 1 },
        { key: "2024-W14", value: 1 },
        { key: "2025-W01", value: 1 },
      ],
      day_of_week: [
        { key: "Monday", value: 2 },
        { key: "Wednesday", value: 1 },
        { key: "Thursday", value: 1 },
        { key: "Saturday", value: 1 },
      ],
      is_weekend: [
        { key: false, value: 4 },
        { key: true, value: 1 },
      ],
    } as const;

    for (const [datePart, groups] of Object.entries(expected)) {
      const result = await queryConversationResource(resource, {
        resourceId: resource.id,
        operation: "table_aggregate",
        aggregate: "count",
        groupByColumn: "order_date",
        groupByDatePart: datePart as keyof typeof expected,
      });
      expect(result).toMatchObject({
        groupBy: { column: "order_date", datePart },
        receipt: {
          scannedRows: 6,
          groupedRows: 5,
          unparseableGroupRows: 1,
          resultCoverage: "full",
        },
      });
      expect(result.groups).toEqual(
        groups.map((group) => ({
          ...group,
          rowCount: group.value,
        })),
      );
    }
  });

  it("preserves boolean filter literals without widening them to the full table", async () => {
    const resource = textResource(
      "refunds.csv",
      [
        "order_id,refunded",
        "1,TRUE",
        "2,FALSE",
        "3,true",
        "4,false",
      ].join("\n"),
      "spreadsheet",
    );
    const input = parseConversationResourceQueryInput({
      resourceId: resource.id,
      operation: "table_filter",
      filterColumn: "refunded",
      filterOperator: "equals",
      filterValue: true,
    });

    expect(input.filterValue).toBe(true);
    await expect(
      queryConversationResource(resource, input),
    ).resolves.toMatchObject({
      receipt: {
        scannedRows: 4,
        matchedRows: 2,
        returnedRows: 2,
        resultCoverage: "full",
      },
      rows: [
        expect.objectContaining({ order_id: "1", refunded: "TRUE" }),
        expect.objectContaining({ order_id: "3", refunded: "true" }),
      ],
    });

    await expect(
      queryConversationResource(resource, {
        ...input,
        operation: "table_aggregate",
        aggregate: "count",
      }),
    ).resolves.toMatchObject({
      value: 2,
      receipt: { scannedRows: 4, matchedRows: 2 },
    });

    const falseInput = parseConversationResourceQueryInput({
      ...input,
      filterValue: false,
    });
    expect(falseInput.filterValue).toBe(false);
    await expect(
      queryConversationResource(resource, falseInput),
    ).resolves.toMatchObject({
      receipt: { scannedRows: 4, matchedRows: 2, returnedRows: 2 },
    });

    await expect(
      queryConversationResource(resource, {
        ...input,
        filterOperator: "greater_than",
      }),
    ).rejects.toThrow(/boolean filter values support only equals or not_equals/i);
  });

  it("normalizes mixed-format dates and reports unparseable rows", async () => {
    const resource = textResource(
      "orders.csv",
      [
        "order_id,order_date",
        "1,2026-01-15",
        "2,3/25/2024",
        "3,1/5/2026",
        "4,2025-12-31",
        "5,2026-02-30",
        "6,not-a-date",
        "7,",
      ].join("\n"),
      "spreadsheet",
    );

    const result = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "table_filter",
      filterColumn: "order_date",
      filterOperator: "greater_than_or_equal",
      filterValue: "2026-01-01",
    });

    expect(result).toMatchObject({
      receipt: {
        scannedRows: 7,
        matchedRows: 2,
        returnedRows: 2,
        resultCoverage: "full",
        unparseableRows: 3,
        warnings: [
          "3 rows could not be parsed as dates and were excluded.",
        ],
        filter: {
          column: "order_date",
          operator: "greater_than_or_equal",
          value: "2026-01-01",
          comparison: "date",
        },
      },
      rows: [
        expect.objectContaining({ order_id: "1", order_date: "2026-01-15" }),
        expect.objectContaining({ order_id: "3", order_date: "1/5/2026" }),
      ],
    });
    expect(JSON.stringify(result)).not.toContain("3/25/2024");

    await expect(
      queryConversationResource(resource, {
        resourceId: resource.id,
        operation: "table_filter",
        filterColumn: "order_date",
        filterOperator: "equals",
        filterValue: "2026-01-05",
      }),
    ).resolves.toMatchObject({
      receipt: { matchedRows: 1, unparseableRows: 3 },
      rows: [expect.objectContaining({ order_id: "3", order_date: "1/5/2026" })],
    });
  });

  it("preserves scalar comparison when the target column has no date values", async () => {
    const resource = textResource(
      "labels.csv",
      ["id,label", "1,before", "2,release-2026-01-01"].join("\n"),
      "spreadsheet",
    );

    await expect(
      queryConversationResource(resource, {
        resourceId: resource.id,
        operation: "table_filter",
        filterColumn: "label",
        filterOperator: "equals",
        filterValue: "2026-01-01",
      }),
    ).resolves.toMatchObject({
      receipt: {
        matchedRows: 0,
        filter: { comparison: "scalar" },
      },
      rows: [],
    });
  });

  it("reads every XLSX row and every sheet before reporting an aggregate", async () => {
    const workbook = new ExcelJS.Workbook();
    const first = workbook.addWorksheet("First");
    first.addRow(["id", "amount", "marker"]);
    for (let index = 1; index <= 100; index += 1) {
      first.addRow([
        index,
        index,
        index === 1
          ? "BEGIN_XLSX_FACT"
          : index === 50
            ? "MIDDLE_XLSX_FACT"
            : index === 100
              ? "END_XLSX_FACT"
              : "",
      ]);
    }
    const second = workbook.addWorksheet("Second");
    second.addRow(["id", "amount", "marker"]);
    second.addRow([101, 101, "SECOND_SHEET_FACT"]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const resource = binaryResource("facts.xlsx", bytes, "spreadsheet");

    const count = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "table_count",
    });
    const sum = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "table_aggregate",
      column: "amount",
      aggregate: "sum",
    });
    const marker = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "table_filter",
      filterColumn: "marker",
      filterOperator: "equals",
      filterValue: "SECOND_SHEET_FACT",
    });

    expect(count).toMatchObject({
      rowCount: 101,
      bySheet: [
        { sheet: "First", rowCount: 100 },
        { sheet: "Second", rowCount: 1 },
      ],
    });
    expect(sum).toMatchObject({
      value: 5_151,
      receipt: {
        sourceCoverage: "full",
        scannedRows: 101,
        scannedSheets: ["First", "Second"],
      },
    });
    expect(JSON.stringify(marker)).toContain("SECOND_SHEET_FACT");
  });

  it("paginates wide schemas and keeps requested far-right columns in bounded row output", async () => {
    const headers = Array.from({ length: 40 }, (_, index) => `column_${index + 1}`);
    const first = Array.from({ length: 40 }, (_, index) => `first_${index + 1}`);
    const second = Array.from({ length: 40 }, (_, index) => `second_${index + 1}`);
    second[39] = "FAR_RIGHT_FACT";
    const resource = textResource(
      "wide.csv",
      [headers, first, second].map((row) => row.join(",")).join("\n"),
      "spreadsheet",
    );

    const firstSchemaPage = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "table_schema",
      limit: 25,
    });
    const secondSchemaPage = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "table_schema",
      offset: 25,
      limit: 25,
    });
    const filtered = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "table_filter",
      filterColumn: "column_40",
      filterOperator: "equals",
      filterValue: "FAR_RIGHT_FACT",
    });

    expect(firstSchemaPage).toMatchObject({
      receipt: { sourceCoverage: "full", resultCoverage: "partial" },
      sheets: [
        {
          totalColumns: 40,
          returnedColumns: { start: 0, end: 25 },
        },
      ],
    });
    expect(secondSchemaPage).toMatchObject({
      receipt: { sourceCoverage: "full", resultCoverage: "full" },
      sheets: [
        {
          returnedColumns: { start: 25, end: 40 },
          columns: expect.arrayContaining(["column_40"]),
        },
      ],
    });
    expect(filtered).toMatchObject({
      receipt: {
        sourceCoverage: "full",
        resultCoverage: "full",
        matchedRows: 1,
        returnedRows: 1,
      },
      rows: [
        expect.objectContaining({
          column_40: "FAR_RIGHT_FACT",
          _omittedColumns: "15",
        }),
      ],
    });
  });

  it("marks bounded filter and sort windows as partial while reporting full scan counts", async () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      [String(index + 1), "match"].join(","),
    );
    const resource = textResource(
      "bounded.csv",
      ["id,status", ...rows].join("\n"),
      "spreadsheet",
    );

    const filtered = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "table_filter",
      filterColumn: "status",
      filterOperator: "equals",
      filterValue: "match",
      limit: 5,
    });
    const sorted = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "table_sort",
      sortColumn: "id",
      sortDirection: "desc",
      limit: 5,
    });

    expect(filtered).toMatchObject({
      receipt: {
        sourceCoverage: "full",
        resultCoverage: "partial",
        scannedRows: 40,
        matchedRows: 40,
        returnedRows: 5,
      },
    });
    expect(sorted).toMatchObject({
      receipt: {
        sourceCoverage: "full",
        resultCoverage: "partial",
        scannedRows: 40,
        sortedRows: 40,
        returnedRows: 5,
      },
    });
  });

  it("searches complete PDF text with page provenance", async () => {
    const resource = binaryResource(
      "facts.pdf",
      buildPdf([
        "BEGIN_PDF_FACT alpha",
        "MIDDLE_PDF_FACT bravo",
        "END_PDF_FACT charlie",
      ]),
      "document",
    );

    for (const [query, page] of [
      ["BEGIN_PDF_FACT", "page 1"],
      ["MIDDLE_PDF_FACT", "page 2"],
      ["END_PDF_FACT", "page 3"],
    ] as const) {
      const result = await queryConversationResource(resource, {
        resourceId: resource.id,
        operation: "search",
        query,
      });
      expect(result.receipt).toMatchObject({
        sourceCoverage: "full",
        provenance: "page",
      });
      expect(result.matches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ location: page, text: expect.stringContaining(query) }),
        ]),
      );
    }
  });

  it("reports an honest limitation when a PDF has no extractable text layer", async () => {
    const resource = binaryResource(
      "scanned.pdf",
      buildPdf([""]),
      "document",
    );

    const result = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "read",
    });

    expect(result).toMatchObject({
      content: "",
      receipt: {
        lifecycleState: "available",
        sourceCoverage: "partial",
        resultCoverage: "unavailable",
        extractable: false,
        sourceChars: 0,
        sourceUnits: 0,
        provenance: "page",
        limitation: expect.stringContaining("No extractable text"),
      },
    });
  });

  it.each(["partial", "extraction_failed"] as const)(
    "does not claim full source coverage for a %s resource lifecycle",
    async (lifecycleState) => {
      const resource = textResource("limited.txt", "AVAILABLE_PREVIEW_ONLY");
      resource.metadata = {
        storageEncoding: "utf8",
        conversationResource: { lifecycleState },
      };

      const result = await queryConversationResource(resource, {
        resourceId: resource.id,
        operation: "read",
      });

      expect(result).toMatchObject({
        content: expect.stringContaining("AVAILABLE_PREVIEW_ONLY"),
        receipt: {
          lifecycleState,
          sourceCoverage: "partial",
          resultCoverage: "full",
          extractable: true,
          limitation: expect.stringContaining(lifecycleState),
        },
      });
    },
  );

  it("reports manifest metadata without claiming the file was analyzed", async () => {
    const resource = textResource("manifest.txt", "hidden source text");

    const result = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "manifest",
    });

    expect(result.receipt).toMatchObject({
      lifecycleState: "available",
      sourceCoverage: "metadata_only",
      resultCoverage: "metadata_only",
    });
    expect(JSON.stringify(result)).not.toContain("hidden source text");
  });

  it("searches complete DOCX paragraphs with provenance", async () => {
    const resource = binaryResource(
      "facts.docx",
      await docxFixture([
        "BEGIN_DOCX_FACT alpha",
        "MIDDLE_DOCX_FACT bravo",
        "END_DOCX_FACT charlie",
      ]),
      "document",
    );

    const result = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "search",
      query: "END_DOCX_FACT",
    });
    expect(result.receipt).toMatchObject({
      sourceCoverage: "full",
      provenance: "paragraph",
    });
    expect(result.matches).toEqual([
      expect.objectContaining({
        location: "paragraph 3",
        text: expect.stringContaining("END_DOCX_FACT"),
      }),
    ]);
  });

  it("searches every PPTX slide, including slides beyond the old 40-slide preview", async () => {
    const facts = Array.from({ length: 45 }, (_, index) => {
      if (index === 0) return "BEGIN_PPTX_FACT alpha";
      if (index === 22) return "MIDDLE_PPTX_FACT bravo";
      if (index === 44) return "END_PPTX_FACT charlie";
      return `Slide ${index + 1}`;
    });
    const resource = binaryResource(
      "facts.pptx",
      await pptxFixture(facts),
      "presentation",
    );

    const result = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "search",
      query: "END_PPTX_FACT",
    });
    expect(result.receipt).toMatchObject({
      sourceCoverage: "full",
      sourceUnits: 45,
      provenance: "slide",
    });
    expect(result.matches).toEqual([
      expect.objectContaining({
        location: "slide 45",
        text: expect.stringContaining("END_PPTX_FACT"),
      }),
    ]);
  });

  it.each([
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
  ])("retains authorized native bytes and dimensions for .%s", async (extension, mimeType) => {
    const resource: ConversationResourceArtifact = {
      ...binaryResource(`screen.${extension}`, Buffer.from("native-image"), "image"),
      mimeType,
      metadata: {
        storageEncoding: "base64",
        image: { width: 640, height: 480 },
      },
    };
    const result = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "read",
    });

    expect(result).toMatchObject({
      receipt: {
        representation: "native_image",
        sourceCoverage: "full",
        resultCoverage: "metadata_only",
      },
      image: {
        mimeType,
        sizeBytes: resource.sizeBytes,
        width: 640,
        height: 480,
      },
    });
  });

  it("validates the model-facing tool arguments before any resource load", () => {
    expect(() =>
      parseConversationResourceQueryInput({
        resourceId: "resource-1",
        operation: "delete_everything",
      }),
    ).toThrow(/operation must be one of/i);
    expect(
      parseConversationResourceQueryInput({
        resourceId: "resource-1",
        operation: "table_aggregate",
        column: "revenue",
        aggregate: "sum",
      }),
    ).toMatchObject({
      resourceId: "resource-1",
      operation: "table_aggregate",
      column: "revenue",
      aggregate: "sum",
    });
    expect(
      parseConversationResourceQueryInput({
        resourceId: "resource-1",
        operation: "table_aggregate",
        aggregate: "count",
        filterLogic: "or",
        filters: [
          { column: "region", operator: "equals", value: "East" },
          { column: "refunded", operator: "equals", value: true },
        ],
        groupByColumn: "order_date",
        groupByDatePart: "month",
      }),
    ).toMatchObject({
      filterLogic: "or",
      filters: [
        { column: "region", operator: "equals", value: "East" },
        { column: "refunded", operator: "equals", value: true },
      ],
      groupByColumn: "order_date",
      groupByDatePart: "month",
    });
    expect(() =>
      parseConversationResourceQueryInput({
        resourceId: "resource-1",
        operation: "table_filter",
        filters: Array.from({ length: 4 }, () => ({
          column: "region",
          operator: "equals",
          value: "East",
        })),
      }),
    ).toThrow(/between 1 and 3 predicates/i);
    expect(() =>
      parseConversationResourceQueryInput({
        resourceId: "resource-1",
        operation: "table_filter",
        filterColumn: "region",
        filterOperator: "equals",
        filterValue: "East",
        filters: [{ column: "region", operator: "equals", value: "West" }],
      }),
    ).toThrow(/either filters or filterColumn/i);
    expect(() =>
      parseConversationResourceQueryInput({
        resourceId: "resource-1",
        operation: "table_aggregate",
        aggregate: "count",
        filterLogic: "or",
      }),
    ).toThrow(/filterLogic requires at least one filter/i);
    expect(() =>
      parseConversationResourceQueryInput({
        resourceId: "resource-1",
        operation: "table_aggregate",
        aggregate: "count",
        groupByColumn: "   ",
      }),
    ).toThrow(/groupByColumn must be a non-empty string/i);
  });
});

function textResource(
  filename: string,
  content: string,
  kind: ConversationResourceArtifact["kind"] = "text",
): ConversationResourceArtifact {
  return {
    id: `resource-${filename}`,
    filename,
    mimeType: filename.endsWith(".csv")
      ? "text/csv"
      : filename.endsWith(".tsv")
        ? "text/tab-separated-values"
        : "text/plain",
    kind,
    content,
    sizeBytes: Buffer.byteLength(content),
    metadata: { storageEncoding: "utf8" },
  };
}

function binaryResource(
  filename: string,
  bytes: Buffer,
  kind: ConversationResourceArtifact["kind"],
): ConversationResourceArtifact {
  return {
    id: `resource-${filename}`,
    filename,
    mimeType: "application/octet-stream",
    kind,
    content: bytes.toString("base64"),
    sizeBytes: bytes.byteLength,
    metadata: { storageEncoding: "base64" },
  };
}

function buildPdf(pageTexts: readonly string[]): Buffer {
  const fontObjectId = 3 + pageTexts.length * 2;
  const bodies: Array<string | Buffer> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageTexts
      .map((_, index) => `${3 + index * 2} 0 R`)
      .join(" ")}] /Count ${pageTexts.length} >>`,
  ];
  for (const [index, pageText] of pageTexts.entries()) {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    const stream = `BT /F1 12 Tf 72 720 Td (${pageText}) Tj ET`;
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  bodies.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  let offset = parts[0]!.length;
  for (const [index, body] of bodies.entries()) {
    offsets.push(offset);
    const object = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      typeof body === "string" ? Buffer.from(body) : body,
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(object);
    offset += object.length;
  }
  const xrefOffset = offset;
  parts.push(
    Buffer.from(
      [
        `xref\n0 ${bodies.length + 1}`,
        "0000000000 65535 f ",
        ...offsets
          .slice(1)
          .map(
            (value) =>
              `${String(value).padStart(10, "0")} 00000 n `,
          ),
        `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>`,
        `startxref\n${xrefOffset}`,
        "%%EOF\n",
      ].join("\n"),
    ),
  );
  return Buffer.concat(parts);
}

async function docxFixture(paragraphs: readonly string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs
      .map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`)
      .join("")}<w:sectPr/></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function pptxFixture(slides: readonly string[]): Promise<Buffer> {
  const zip = new JSZip();
  for (const [index, text] of slides.entries()) {
    zip.file(
      `ppt/slides/slide${index + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
  }
  return zip.generateAsync({ type: "nodebuffer" });
}
