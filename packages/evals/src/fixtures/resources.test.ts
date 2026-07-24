import { describe, expect, it } from "vitest";
import {
  createConversationResourceFixtureTool,
  resourceFixtureIds,
} from "./resources";

describe("conversation resource eval fixture", () => {
  it("matches production's filtered-row receipt and string-cell shape", async () => {
    const tool = createConversationResourceFixtureTool();
    const output = await tool.handler(
      {
        resourceId: resourceFixtureIds.inventoryCsv,
        operation: "table_filter",
        filterColumn: "SKU",
        filterOperator: "equals",
        filterValue: "VX-204",
      },
      { userId: "eval" },
    );

    expect(output).toMatchObject({
      receipt: {
        representation: "tabular_dataset",
        sourceCoverage: "full",
        resultCoverage: "full",
        scannedRows: 3,
        scannedSheets: ["Data"],
        matchedRows: 1,
        returnedRows: 1,
        filter: {
          column: "SKU",
          operator: "equals",
          value: "VX-204",
          comparison: "scalar",
        },
      },
      rows: [
        {
          _sheet: "Data",
          sku: "VX-204",
          item: "Vision sensor",
          stock: "7",
          reorderPoint: "12",
        },
      ],
    });
    expect(output).not.toHaveProperty("matchedRows");
  });

  it("supports production's filtered aggregate contract", async () => {
    const tool = createConversationResourceFixtureTool();
    const output = await tool.handler(
      {
        resourceId: resourceFixtureIds.revenueCsv,
        operation: "table_aggregate",
        column: "revenue",
        aggregate: "sum",
        filterColumn: "segment",
        filterOperator: "equals",
        filterValue: "Enterprise",
      },
      { userId: "eval" },
    );

    expect(output).toMatchObject({
      receipt: {
        representation: "tabular_dataset",
        scannedRows: 4,
        matchedRows: 2,
        resultCoverage: "full",
      },
      aggregate: "sum",
      column: "revenue",
      value: 121_223,
      numericValues: 2,
      inspectedValues: 2,
    });
  });

  it("matches production's sort and sample envelopes", async () => {
    const tool = createConversationResourceFixtureTool();
    const sorted = await tool.handler(
      {
        resourceId: resourceFixtureIds.revenueCsv,
        operation: "table_sort",
        sortColumn: "revenue",
        sortDirection: "desc",
        limit: 1,
      },
      { userId: "eval" },
    );
    const sampled = await tool.handler(
      {
        resourceId: resourceFixtureIds.revenueCsv,
        operation: "table_sample",
        position: "end",
        limit: 1,
      },
      { userId: "eval" },
    );

    expect(sorted).toMatchObject({
      receipt: {
        sortedRows: 4,
        returnedRows: 1,
        resultCoverage: "partial",
      },
      rows: [
        {
          _sheet: "Data",
          customer: "Meridian Health",
          revenue: "73006",
        },
      ],
    });
    expect(sampled).toMatchObject({
      receipt: { resultCoverage: "partial" },
      samples: [
        {
          sheet: "Data",
          position: "end",
          rowNumbers: { start: 5, end: 5 },
          rows: [{ customer: "Copper Finch", revenue: "9876" }],
        },
      ],
    });
    expect(sampled).not.toHaveProperty("rows");
  });

  it("matches production's document read and search envelopes", async () => {
    const tool = createConversationResourceFixtureTool();
    const read = await tool.handler(
      {
        resourceId: resourceFixtureIds.projectNotes,
        operation: "read",
      },
      { userId: "eval" },
    );
    const search = await tool.handler(
      {
        resourceId: resourceFixtureIds.projectNotes,
        operation: "search",
        query: "vendor security",
      },
      { userId: "eval" },
    );

    expect(read).toMatchObject({
      receipt: {
        representation: "addressable_text",
        sourceCoverage: "full",
        resultCoverage: "full",
        provenance: "character_range",
        sourceUnits: 1,
      },
    });
    expect(read).toHaveProperty(
      "content",
      expect.stringContaining("Owner: Priya Shah"),
    );
    expect(read).not.toHaveProperty("sections");
    expect(search).toMatchObject({
      receipt: {
        representation: "addressable_text",
        resultCoverage: "search_results",
        matchedSections: 1,
      },
      query: "vendor security",
      matches: [
        {
          location: expect.stringMatching(/^characters /),
          text: expect.stringContaining("vendor security review"),
        },
      ],
    });
  });

  it("returns available columns when a model guesses the wrong field", async () => {
    const tool = createConversationResourceFixtureTool();

    await expect(
      tool.handler(
        {
          resourceId: resourceFixtureIds.revenueCsv,
          operation: "table_filter",
          filterColumn: "company",
          filterOperator: "equals",
          filterValue: "Northstar Labs",
        },
        { userId: "eval" },
      ),
    ).rejects.toThrow(
      'Column "company" was not found in sheet "Data". Available: customer, revenue, segment, status.',
    );
  });
});
