import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { validateAttachments } from "@/lib/attachments";

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
});
