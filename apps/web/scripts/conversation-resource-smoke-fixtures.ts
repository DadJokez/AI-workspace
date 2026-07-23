import { readFile } from "node:fs/promises";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import { mimeTypeForAttachmentName } from "@/lib/attachments";

export type ProductionResourceFixtureKind =
  | "text"
  | "table"
  | "document"
  | "presentation"
  | "image";

export interface ProductionResourceFixture {
  extension: string;
  kind: ProductionResourceFixtureKind;
  filename: string;
  mimeType: string;
  bytes: Buffer;
  expectedFacts: [string, string, string];
  expectedAggregate?: number;
}

const IMAGE_FACTS: [string, string, string] = [
  "DURABLE IMAGE FACT BEGIN ALPHA",
  "DURABLE IMAGE FACT MIDDLE BRAVO",
  "DURABLE IMAGE FACT END CHARLIE",
];

export async function buildProductionResourceFixtures(
  runId: string,
): Promise<ProductionResourceFixture[]> {
  const text = textFixture("txt", runId);
  const csv = tableTextFixture("csv", ",", runId);
  const tsv = tableTextFixture("tsv", "\t", runId);
  const xlsxFacts = factsFor("xlsx", runId);
  const pdfFacts = factsFor("pdf", runId);
  const docxFacts = factsFor("docx", runId);
  const pptxFacts = factsFor("pptx", runId);

  return [
    text,
    csv,
    tsv,
    {
      extension: "xlsx",
      kind: "table",
      filename: filenameFor("xlsx", runId),
      mimeType: mimeTypeForAttachmentName("fixture.xlsx"),
      bytes: await xlsxFixture(xlsxFacts),
      expectedFacts: xlsxFacts,
      expectedAggregate: 66,
    },
    {
      extension: "pdf",
      kind: "document",
      filename: filenameFor("pdf", runId),
      mimeType: mimeTypeForAttachmentName("fixture.pdf"),
      bytes: pdfFixture(pdfFacts),
      expectedFacts: pdfFacts,
    },
    {
      extension: "docx",
      kind: "document",
      filename: filenameFor("docx", runId),
      mimeType: mimeTypeForAttachmentName("fixture.docx"),
      bytes: await docxFixture(docxFacts),
      expectedFacts: docxFacts,
    },
    {
      extension: "pptx",
      kind: "presentation",
      filename: filenameFor("pptx", runId),
      mimeType: mimeTypeForAttachmentName("fixture.pptx"),
      bytes: await pptxFixture(pptxFacts),
      expectedFacts: pptxFacts,
    },
    ...(await Promise.all(
      ["png", "jpg", "jpeg", "webp"].map(async (extension) => ({
        extension,
        kind: "image" as const,
        filename: filenameFor(extension, runId),
        mimeType: mimeTypeForAttachmentName(`fixture.${extension}`),
        bytes: await readFile(
          new URL(
            `./fixtures/conversation-resources/durable-image.${extension}`,
            import.meta.url,
          ),
        ),
        expectedFacts: IMAGE_FACTS,
      })),
    )),
  ];
}

function textFixture(
  extension: string,
  runId: string,
): ProductionResourceFixture {
  const facts = factsFor(extension, runId);
  return {
    extension,
    kind: "text",
    filename: filenameFor(extension, runId),
    mimeType: mimeTypeForAttachmentName(`fixture.${extension}`),
    bytes: Buffer.from(
      [
        facts[0],
        "Orientation paragraph between the first and middle facts.",
        facts[1],
        "Closing paragraph between the middle and final facts.",
        facts[2],
      ].join("\n\n"),
      "utf8",
    ),
    expectedFacts: facts,
  };
}

function tableTextFixture(
  extension: "csv" | "tsv",
  delimiter: string,
  runId: string,
): ProductionResourceFixture {
  const facts = factsFor(extension, runId);
  const rows = [
    ["id", "amount", "marker"],
    ["1", "11", facts[0]],
    ["2", "22", facts[1]],
    ["3", "33", facts[2]],
  ];
  return {
    extension,
    kind: "table",
    filename: filenameFor(extension, runId),
    mimeType: mimeTypeForAttachmentName(`fixture.${extension}`),
    bytes: Buffer.from(
      rows.map((row) => row.join(delimiter)).join("\n"),
      "utf8",
    ),
    expectedFacts: facts,
    expectedAggregate: 66,
  };
}

async function xlsxFixture(
  facts: readonly string[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Complete dataset");
  sheet.addRow(["id", "amount", "marker"]);
  facts.forEach((fact, index) => {
    sheet.addRow([index + 1, (index + 1) * 11, fact]);
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function pdfFixture(facts: readonly string[]): Buffer {
  const fontObjectId = 3 + facts.length * 2;
  const bodies: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${facts
      .map((_fact, index) => `${3 + index * 2} 0 R`)
      .join(" ")}] /Count ${facts.length} >>`,
  ];
  facts.forEach((fact, index) => {
    const contentId = 4 + index * 2;
    const stream = `BT /F1 12 Tf 72 720 Td (${escapePdfText(fact)}) Tj ET`;
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  });
  bodies.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  let offset = parts[0]!.length;
  bodies.forEach((body, index) => {
    offsets.push(offset);
    const object = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`);
    parts.push(object);
    offset += object.length;
  });
  const xrefOffset = offset;
  parts.push(
    Buffer.from(
      [
        `xref\n0 ${bodies.length + 1}`,
        "0000000000 65535 f ",
        ...offsets
          .slice(1)
          .map((value) => `${String(value).padStart(10, "0")} 00000 n `),
        `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>`,
        `startxref\n${xrefOffset}`,
        "%%EOF\n",
      ].join("\n"),
    ),
  );
  return Buffer.concat(parts);
}

async function docxFixture(facts: readonly string[]): Promise<Buffer> {
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
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${facts
      .map((fact) => `<w:p><w:r><w:t>${escapeXml(fact)}</w:t></w:r></w:p>`)
      .join("")}<w:sectPr/></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function pptxFixture(facts: readonly string[]): Promise<Buffer> {
  const zip = new JSZip();
  facts.forEach((fact, index) => {
    zip.file(
      `ppt/slides/slide${index + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${escapeXml(fact)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
  });
  return zip.generateAsync({ type: "nodebuffer" });
}

function factsFor(
  extension: string,
  runId: string,
): [string, string, string] {
  const prefix = `DURABLE_${extension.toUpperCase()}_${runId.toUpperCase()}`;
  return [
    `${prefix}_FACT_BEGIN_ALPHA`,
    `${prefix}_FACT_MIDDLE_BRAVO`,
    `${prefix}_FACT_END_CHARLIE`,
  ];
}

function filenameFor(extension: string, runId: string): string {
  return `durable-${extension}-${runId}.${extension}`;
}

function escapePdfText(value: string): string {
  return value.replace(/([\\()])/g, "\\$1");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
