import { PDFParse } from "pdf-parse";

const text = "PDF runtime smoke";
const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  [
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200]",
    "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  ].join(" "),
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
];

let pdf = "%PDF-1.4\n";
const offsets = [];
for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf, "ascii"));
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
}

const xrefOffset = Buffer.byteLength(pdf, "ascii");
pdf += `xref\n0 ${objects.length + 1}\n`;
pdf += "0000000000 65535 f \n";
for (const offset of offsets) {
  pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
}
pdf += [
  "trailer",
  `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
  "startxref",
  String(xrefOffset),
  "%%EOF",
  "",
].join("\n");

const parser = new PDFParse({
  data: Uint8Array.from(Buffer.from(pdf, "ascii")),
});

try {
  const result = await parser.getText();
  if (!result.text.includes(text)) {
    throw new Error("Production PDF runtime parsed no smoke-test text.");
  }
} finally {
  await parser.destroy();
}
