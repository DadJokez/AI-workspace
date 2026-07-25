import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { validateAttachments } from "@/lib/attachments";

async function createStreamingWorkbook(): Promise<Buffer> {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: output,
    useSharedStrings: false,
    useStyles: true,
  });
  const sheet = workbook.addWorksheet("Pipeline");
  sheet.addRow(["Account", "Stage", "Amount"]).commit();
  sheet.addRow(["Acme, Inc", "Closed Won", 50000]).commit();
  sheet.commit();

  await workbook.commit();
  return Buffer.concat(chunks);
}

describe("xlsx extraction (real workbook fixture, #446)", () => {
  it("extracts CSV from a genuine workbook", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Pipeline");
    ws.addRow(["Account", "Stage", "Amount"]);
    ws.addRow(["Acme, Inc", "Closed Won", 50000]);
    ws.addRow(['Say "hi"', "Open", 1200]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const result = await validateAttachments([
      {
        name: "deals.xlsx",
        dataBase64: buf.toString("base64"),
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: buf.length,
      },
    ]);
    expect(result.ok).toBe(true);
    const content = result.attachments[0]!.content;
    expect(content).toContain("# Sheet: Pipeline");
    expect(content).toContain('"Acme, Inc",Closed Won,50000');
    expect(content).toContain('"Say ""hi""",Open,1200');
  });

  it("keeps ExcelJS streaming archive reads and writes compatible", async () => {
    const workbookBytes = await createStreamingWorkbook();
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(
      Readable.from(workbookBytes),
      {
        worksheets: "emit",
        sharedStrings: "cache",
        hyperlinks: "ignore",
        styles: "cache",
      },
    );
    const rows: unknown[][] = [];

    for await (const worksheet of reader) {
      for await (const row of worksheet) {
        rows.push((row.values as unknown[]).slice(1));
      }
    }

    expect(rows).toEqual([
      ["Account", "Stage", "Amount"],
      ["Acme, Inc", "Closed Won", 50000],
    ]);
  });
});
