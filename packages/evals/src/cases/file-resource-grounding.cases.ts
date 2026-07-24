import type { EvalSuite, TurnTranscript } from "../types";
import {
  RESOURCE_QUERY_TOOL,
  createConversationResourceFixtureTool,
  projectNotes,
  resourceFixtureIds,
  revenueTotal,
} from "../fixtures/resources";

interface ResourceManifestEntry {
  id: string;
  filename: string;
  kind: string;
}

function resourcePrompt(resources: readonly ResourceManifestEntry[]): string {
  return [
    "You are Comparative, an internal work assistant.",
    "Uploaded files are durable conversation resources. Their contents are NOT in this prompt.",
    `You MUST call ${RESOURCE_QUERY_TOOL} before making any claim about a file's contents. Never guess from a filename, preview, or prior knowledge.`,
    "For CSV data, prefer table_filter/table_aggregate/table_sort/table_count over samples. Coverage and limitation fields are authoritative.",
    "For documents, use search or read. If a receipt says coverage is partial, disclose that before drawing a complete-file conclusion.",
    "A tool error means no file claim was established. Report the failure without inventing content.",
    "Authorized resource manifest:",
    ...resources.map(
      (resource) =>
        `- resourceId=${resource.id}; filename=${resource.filename}; kind=${resource.kind}`,
    ),
  ].join("\n");
}

const revenueResource = {
  id: resourceFixtureIds.revenueCsv,
  filename: "alpha-revenue.csv",
  kind: "spreadsheet",
};
const inventoryResource = {
  id: resourceFixtureIds.inventoryCsv,
  filename: "warehouse-inventory.csv",
  kind: "spreadsheet",
};
const projectResource = {
  id: resourceFixtureIds.projectNotes,
  filename: "project-lighthouse.txt",
  kind: "text",
};
const partialResource = {
  id: resourceFixtureIds.partialNotes,
  filename: "partial-board-notes.pdf",
  kind: "document",
};
const missingResource = {
  id: resourceFixtureIds.missing,
  filename: "deleted-source.csv",
  kind: "spreadsheet",
};

function resourceCalls(transcript: TurnTranscript) {
  return transcript.events.flatMap((event) =>
    event.type === "tool-call" && event.call.name === RESOURCE_QUERY_TOOL
      ? [
          typeof event.call.input === "object" && event.call.input !== null
            ? (event.call.input as Record<string, unknown>)
            : {},
        ]
      : [],
  );
}

function calledResource(
  transcript: TurnTranscript,
  resourceId: string,
  operations?: readonly string[],
) {
  const calls = resourceCalls(transcript);
  const matching = calls.filter(
    (input) =>
      input.resourceId === resourceId &&
      (!operations || operations.includes(String(input.operation))),
  );
  return {
    ok: matching.length > 0,
    detail:
      matching.length > 0
        ? undefined
        : `resource calls were ${JSON.stringify(calls)}`,
  };
}

function hasResourceError(transcript: TurnTranscript) {
  return transcript.toolResults.some((result) => result.isError);
}

function calledEnterpriseRevenueAggregate(transcript: TurnTranscript) {
  const calls = resourceCalls(transcript);
  const matched = calls.some(
    (input) =>
      input.resourceId === resourceFixtureIds.revenueCsv &&
      input.operation === "table_aggregate" &&
      String(input.column).toLowerCase() === "revenue" &&
      String(input.aggregate).toLowerCase() === "sum" &&
      String(input.filterColumn).toLowerCase() === "segment" &&
      String(input.filterOperator).toLowerCase() === "equals" &&
      String(input.filterValue).toLowerCase() === "enterprise",
  );
  return {
    ok: matched,
    detail: matched ? undefined : `resource calls were ${JSON.stringify(calls)}`,
  };
}

export const fileResourceGroundingSuite: EvalSuite = {
  capability: "file-resource-grounding",
  defaultModelId: "sonnet-4-5",
  defaultSeverity: "critical",
  tags: ["core", "files", "grounding", "resources"],
  cases: [
    {
      id: "csv-row-lookup",
      description:
        "an exact CSV lookup calls the durable resource tool and preserves the canary value",
      systemPrompt: resourcePrompt([revenueResource]),
      input:
        "In alpha-revenue.csv, what revenue and status are listed for Northstar Labs?",
      tools: [createConversationResourceFixtureTool()],
      providerStatus: { resources: "mounted_fixture" },
      contextReceipts: [
        "alpha-revenue.csv selected as a durable conversation resource",
        "inline attachment chars: 0",
      ],
      fixtureEvidence: ["Northstar Labs — revenue 48,217 — status Active"],
      assertions: [
        {
          kind: "deterministic",
          label: "queries the selected CSV resource",
          check: (transcript) =>
            calledResource(transcript, resourceFixtureIds.revenueCsv, [
              "table_filter",
              "table_sample",
              "read",
            ]),
        },
        {
          kind: "deterministic",
          label: "answers with the exact CSV row",
          check: (transcript) =>
            /Northstar Labs/i.test(transcript.answer) &&
            /48[,\s]?217/.test(transcript.answer) &&
            /\bActive\b/i.test(transcript.answer),
        },
      ],
    },
    {
      id: "csv-tail-row-not-dropped",
      description:
        "a row near the end of a CSV remains queryable instead of disappearing after upload",
      systemPrompt: resourcePrompt([revenueResource]),
      input:
        "Look up Copper Finch in alpha-revenue.csv. Give me its revenue, segment, and status.",
      tools: [createConversationResourceFixtureTool()],
      providerStatus: { resources: "mounted_fixture" },
      contextReceipts: [
        "alpha-revenue.csv resource-backed with full table coverage",
      ],
      fixtureEvidence: [
        "Copper Finch — revenue 9,876 — segment SMB — status Paused",
      ],
      assertions: [
        {
          kind: "deterministic",
          label: "queries the CSV rather than guessing from a preview",
          check: (transcript) =>
            calledResource(transcript, resourceFixtureIds.revenueCsv, [
              "table_filter",
              "table_sample",
            ]),
        },
        {
          kind: "deterministic",
          label: "recovers every requested tail-row field",
          check: (transcript) =>
            /Copper Finch/i.test(transcript.answer) &&
            /9[,\s]?876/.test(transcript.answer) &&
            /\bSMB\b/i.test(transcript.answer) &&
            /\bPaused\b/i.test(transcript.answer),
        },
      ],
    },
    {
      id: "csv-full-column-aggregate",
      description:
        "a CSV total comes from a full-coverage aggregate rather than visible sample rows",
      systemPrompt: resourcePrompt([revenueResource]),
      input: "What is the total of the revenue column in alpha-revenue.csv?",
      tools: [createConversationResourceFixtureTool()],
      providerStatus: { resources: "mounted_fixture" },
      contextReceipts: ["alpha-revenue.csv resource-backed; sourceCoverage=full"],
      fixtureEvidence: [
        `Revenue sum is ${revenueTotal}`,
        "The aggregate scans 4 rows",
      ],
      assertions: [
        {
          kind: "deterministic",
          label: "uses a full-table aggregate",
          check: (transcript) =>
            calledResource(transcript, resourceFixtureIds.revenueCsv, [
              "table_aggregate",
            ]),
        },
        {
          kind: "deterministic",
          label: "reports the exact full-column total",
          check: (transcript) => /144[,\s]?508/.test(transcript.answer),
        },
      ],
    },
    {
      id: "csv-filtered-total",
      description:
        "a filtered CSV question uses matching rows and computes only the requested segment",
      systemPrompt: resourcePrompt([revenueResource]),
      input:
        "Using alpha-revenue.csv, total the revenue for Enterprise customers only.",
      tools: [createConversationResourceFixtureTool()],
      providerStatus: { resources: "mounted_fixture" },
      contextReceipts: ["alpha-revenue.csv resource-backed; sourceCoverage=full"],
      fixtureEvidence: [
        "Enterprise rows are Northstar Labs 48,217 and Meridian Health 73,006",
        "Enterprise revenue total is 121,223",
      ],
      assertions: [
        {
          kind: "deterministic",
          label: "uses the production filtered-aggregate contract",
          check: calledEnterpriseRevenueAggregate,
        },
        {
          kind: "deterministic",
          label: "reports the filtered total rather than the all-row total",
          check: (transcript) =>
            /121[,\s]?223/.test(transcript.answer) &&
            !/144[,\s]?508/.test(transcript.answer),
        },
      ],
    },
    {
      id: "csv-sort-top-row",
      description:
        "a top-row question uses table sorting and identifies the correct maximum",
      systemPrompt: resourcePrompt([revenueResource]),
      input:
        "Which customer in alpha-revenue.csv has the highest revenue, and what is it?",
      tools: [createConversationResourceFixtureTool()],
      providerStatus: { resources: "mounted_fixture" },
      fixtureEvidence: ["Meridian Health has the highest revenue at 73,006"],
      assertions: [
        {
          kind: "deterministic",
          label: "sorts or aggregates the requested CSV column",
          check: (transcript) =>
            calledResource(transcript, resourceFixtureIds.revenueCsv, [
              "table_sort",
              "table_aggregate",
              "table_sample",
            ]),
        },
        {
          kind: "deterministic",
          label: "identifies the correct top customer and value",
          check: (transcript) =>
            /Meridian Health/i.test(transcript.answer) &&
            /73[,\s]?006/.test(transcript.answer),
        },
      ],
    },
    {
      id: "multiple-files-selects-named-resource",
      description:
        "with multiple uploads, the named file's resource id is used without cross-contamination",
      systemPrompt: resourcePrompt([revenueResource, inventoryResource]),
      input:
        "In warehouse-inventory.csv—not the revenue file—what is the stock and reorder point for SKU VX-204?",
      tools: [createConversationResourceFixtureTool()],
      providerStatus: { resources: "mounted_fixture" },
      contextReceipts: [
        "alpha-revenue.csv and warehouse-inventory.csv both authorized",
      ],
      fixtureEvidence: ["VX-204 — stock 7 — reorder point 12"],
      assertions: [
        {
          kind: "deterministic",
          label: "queries the explicitly named inventory resource",
          check: (transcript) =>
            calledResource(transcript, resourceFixtureIds.inventoryCsv, [
              "table_filter",
              "table_sample",
            ]),
        },
        {
          kind: "deterministic",
          label: "does not query the unrelated revenue resource",
          check: (transcript) =>
            !resourceCalls(transcript).some(
              (input) => input.resourceId === resourceFixtureIds.revenueCsv,
            ),
        },
        {
          kind: "deterministic",
          label: "answers with the inventory row",
          check: (transcript) =>
            /VX-204/i.test(transcript.answer) &&
            /\b7\b/.test(transcript.answer) &&
            /\b12\b/.test(transcript.answer),
        },
      ],
    },
    {
      id: "document-search-grounding",
      description:
        "a document question searches the selected resource and preserves owner/date facts",
      systemPrompt: resourcePrompt([projectResource]),
      input:
        "From project-lighthouse.txt, who owns Project Lighthouse and what is its launch date?",
      tools: [createConversationResourceFixtureTool()],
      providerStatus: { resources: "mounted_fixture" },
      contextReceipts: [
        "project-lighthouse.txt selected as a durable conversation resource",
      ],
      fixtureEvidence: ["Owner Priya Shah", "Launch date 2026-09-17"],
      assertions: [
        {
          kind: "deterministic",
          label: "reads or searches the selected document",
          check: (transcript) =>
            calledResource(transcript, resourceFixtureIds.projectNotes, [
              "search",
              "read",
            ]),
        },
        {
          kind: "deterministic",
          label: "answers with exact document facts",
          check: (transcript) =>
            /Priya Shah/i.test(transcript.answer) &&
            /2026-09-17|September 17(?:,|th)? 2026/i.test(transcript.answer),
        },
      ],
    },
    {
      id: "document-risk-detail",
      description:
        "a specific detail in document content survives the resource boundary",
      systemPrompt: resourcePrompt([projectResource]),
      input:
        "What open risk and due date are recorded in project-lighthouse.txt?",
      tools: [createConversationResourceFixtureTool()],
      providerStatus: { resources: "mounted_fixture" },
      fixtureEvidence: [
        "Open risk is vendor security review",
        "Risk due date is 2026-08-29",
      ],
      assertions: [
        {
          kind: "deterministic",
          label: "queries the document content",
          check: (transcript) =>
            calledResource(transcript, resourceFixtureIds.projectNotes, [
              "search",
              "read",
            ]),
        },
        {
          kind: "deterministic",
          label: "reports the exact risk and due date",
          check: (transcript) =>
            /vendor security review/i.test(transcript.answer) &&
            /2026-08-29|August 29(?:,|th)? 2026/i.test(transcript.answer),
        },
      ],
    },
    {
      id: "file-follow-up-still-queries-resource",
      description:
        "a later-turn follow-up can still access the durable file instead of losing it",
      systemPrompt: resourcePrompt([revenueResource]),
      input: "And what status did that row have?",
      messages: [
        {
          role: "user",
          content:
            "I attached alpha-revenue.csv. What revenue is listed for Juniper Ridge?",
        },
        {
          role: "assistant",
          content: "Juniper Ridge is listed at 13,409 in revenue.",
        },
        { role: "user", content: "And what status did that row have?" },
      ],
      tools: [createConversationResourceFixtureTool()],
      providerStatus: { resources: "mounted_fixture" },
      contextReceipts: [
        "alpha-revenue.csv retained as a durable thread resource",
        "follow-up resolved to resource-revenue-csv",
      ],
      fixtureEvidence: ["Juniper Ridge status is At Risk"],
      assertions: [
        {
          kind: "deterministic",
          label: "re-queries the durable CSV on the follow-up",
          check: (transcript) =>
            calledResource(transcript, resourceFixtureIds.revenueCsv, [
              "table_filter",
              "table_sample",
            ]),
        },
        {
          kind: "deterministic",
          label: "answers the follow-up with the retained row",
          check: (transcript) => /At Risk/i.test(transcript.answer),
        },
      ],
    },
    {
      id: "partial-extraction-is-disclosed",
      description:
        "partial document extraction is never presented as complete-file certainty",
      systemPrompt: resourcePrompt([partialResource]),
      input:
        "What did the board decide in partial-board-notes.pdf? Is that the complete decision record?",
      tools: [createConversationResourceFixtureTool()],
      providerStatus: { resources: "mounted_fixture_partial" },
      contextReceipts: [
        "partial-board-notes.pdf lifecycleState=partial",
      ],
      fixtureEvidence: [
        "Recovered page 1 says the vote was postponed pending legal review",
        "Extraction stopped after page 1; later pages are unavailable",
      ],
      assertions: [
        {
          kind: "deterministic",
          label: "queries the partial document",
          check: (transcript) =>
            calledResource(transcript, resourceFixtureIds.partialNotes, [
              "search",
              "read",
            ]),
        },
        {
          kind: "deterministic",
          label: "uses the recovered fact",
          check: (transcript) =>
            /postponed/i.test(transcript.answer) &&
            /legal review/i.test(transcript.answer),
        },
        {
          kind: "deterministic",
          label: "warns that file coverage is incomplete",
          check: (transcript) =>
            /(partial|incomplete|page 1|later pages|not (the )?complete|unavailable)/i.test(
              transcript.answer,
            ),
        },
        {
          kind: "judge",
          label: "does not overstate a partial extraction",
          rubric:
            "Only page 1 was recovered and later pages are unavailable. PASS if the answer reports the recovered postponed-vote fact while clearly warning that it cannot establish the complete decision record.",
        },
      ],
    },
    {
      id: "missing-resource-fails-honestly",
      description:
        "a deleted or unavailable file produces a visible failure rather than invented contents",
      systemPrompt: resourcePrompt([missingResource]),
      input:
        "What total revenue is in deleted-source.csv? Give me the exact number.",
      tools: [createConversationResourceFixtureTool()],
      providerStatus: { resources: "mounted_fixture_missing" },
      contextReceipts: [
        "deleted-source.csv selected but backing resource is unavailable",
      ],
      fixtureEvidence: [
        "Resource query fails because the conversation resource is unavailable or deleted",
        "No revenue total is established",
      ],
      assertions: [
        {
          kind: "deterministic",
          label: "attempts the selected resource query",
          check: (transcript) =>
            calledResource(transcript, resourceFixtureIds.missing),
        },
        {
          kind: "deterministic",
          label: "captures a resource tool error",
          check: hasResourceError,
        },
        {
          kind: "deterministic",
          label: "surfaces the missing-file failure",
          check: (transcript) =>
            /(unavailable|deleted|couldn'?t|could not|failed|error)/i.test(
              transcript.answer,
            ),
        },
        {
          kind: "judge",
          label: "does not invent an exact file total",
          rubric:
            "The selected resource query failed because the file is unavailable or deleted, so no total exists in evidence. PASS only if the answer reports that limitation and does not fabricate a revenue number.",
        },
      ],
    },
    {
      id: "document-complete-fact-set",
      description:
        "a complete-file request recovers all material document facts without dropping one",
      systemPrompt: resourcePrompt([projectResource]),
      input:
        "Give me the owner, launch date, approved budget, beta limit, and open risk from project-lighthouse.txt.",
      tools: [createConversationResourceFixtureTool()],
      providerStatus: { resources: "mounted_fixture" },
      fixtureEvidence: projectNotes.split("\n").slice(1),
      assertions: [
        {
          kind: "deterministic",
          label: "reads the selected document",
          check: (transcript) =>
            calledResource(transcript, resourceFixtureIds.projectNotes, [
              "read",
              "search",
            ]),
        },
        {
          kind: "deterministic",
          label: "preserves the complete requested fact set",
          check: (transcript) => {
            const expected = [
              "Priya Shah",
              "2026-09-17",
              "284,500",
              "vendor security review",
              "2026-08-29",
            ];
            const missing = expected.filter(
              (fact) => !transcript.answer.toLowerCase().includes(fact.toLowerCase()),
            );
            if (!/\b(?:twelve|12)\b/i.test(transcript.answer)) {
              missing.push("twelve/12");
            }
            return {
              ok: missing.length === 0,
              detail: missing.length
                ? `missing document facts: ${missing.join(", ")}`
                : undefined,
            };
          },
        },
      ],
    },
  ],
};
