import { describe, expect, it } from "vitest";
import {
  SOQL_TOOL,
  createSalesforceFixtureTools,
} from "./salesforce";

describe("Salesforce eval fixture", () => {
  it("returns truthful one-row ungrouped aggregate results", async () => {
    const tool = createSalesforceFixtureTools().find(
      (candidate) => candidate.name === SOQL_TOOL,
    );
    if (!tool) throw new Error("missing Salesforce SOQL fixture tool");

    const output = await tool.handler(
      {
        soql: "SELECT COUNT() total, SUM(Amount) pipeline FROM Opportunity WHERE IsClosed = false",
      },
      { userId: "eval" },
    );

    expect(output).toEqual({
      provider: "salesforce",
      totalSize: 1,
      done: true,
      records: [
        {
          attributes: { type: "AggregateResult" },
          total: 2,
          pipeline: 730_000,
        },
      ],
    });
  });
});
