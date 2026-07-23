import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import {
  MAX_ATTACHMENT_CHARS,
  SUPPORTED_BINARY_EXTENSIONS,
  SUPPORTED_TEXT_EXTENSIONS,
  mimeTypeForAttachmentName,
  type PreparedChatAttachment,
  validateAttachments,
} from "@/lib/attachments";
import {
  queryConversationResource,
  type ConversationResourceArtifact,
} from "@/lib/conversation-resource-content";

const NON_IMAGE_SIZES = [3.8, 7.8, 9.5].map((sizeMiB) => ({
  label: `${sizeMiB} MiB`,
  bytes: Math.floor(sizeMiB * 1024 * 1024),
}));
const IMAGE_SIZES = [1_500_000, 2_750_000, 3_500_000].map((bytes) => ({
  label: `${(bytes / 1_000_000).toFixed(2)} MB`,
  bytes,
}));
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
const MATRIX_MARKERS = [
  "DURABLE_MATRIX_FACT_BEGIN",
  "DURABLE_MATRIX_FACT_MIDDLE",
  "DURABLE_MATRIX_FACT_END",
] as const;

const NON_IMAGE_CASES = [
  ...SUPPORTED_TEXT_EXTENSIONS,
  ...SUPPORTED_BINARY_EXTENSIONS.filter((ext) => !IMAGE_EXTENSIONS.has(ext)),
].flatMap((extension) =>
  NON_IMAGE_SIZES.map((size) => ({ extension, ...size })),
);
const IMAGE_CASES = SUPPORTED_BINARY_EXTENSIONS.filter((ext) =>
  IMAGE_EXTENSIONS.has(ext),
).flatMap((extension) =>
  IMAGE_SIZES.map((size) => ({ extension, ...size })),
);

/**
 * Exhaustive server-boundary matrix for #575. Fixtures are generated in
 * memory so CI exercises real parsers without checking ~1 GB of binaries into
 * git. Every extension exported by the production allowlist gets three large
 * decoded-byte payloads.
 */
describe.sequential("large attachment acceptance matrix (#575)", () => {
  it("covers every advertised extension at three sizes", () => {
    const covered = new Set(
      [...NON_IMAGE_CASES, ...IMAGE_CASES].map((testCase) => testCase.extension),
    );
    expect(covered).toEqual(
      new Set([...SUPPORTED_TEXT_EXTENSIONS, ...SUPPORTED_BINARY_EXTENSIONS]),
    );
    expect(NON_IMAGE_CASES.length + IMAGE_CASES.length).toBe(
      (SUPPORTED_TEXT_EXTENSIONS.length + SUPPORTED_BINARY_EXTENSIONS.length) *
        3,
    );
  });

  it.each(NON_IMAGE_CASES)(
    "accepts $label .$extension through its real extractor",
    async ({ extension, bytes }) => {
      const buffer = await largeFixture(extension, bytes);
      const filename = `large-acceptance.${extension}`;
      const result = await validateAttachments([
        {
          name: filename,
          mimeType: mimeTypeForAttachmentName(filename),
          dataBase64: buffer.toString("base64"),
          // Decoded bytes, not this client claim, remain authoritative.
          sizeBytes: 1,
        },
      ]);

      expect(result.ok, result.error).toBe(true);
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]?.sizeBytes).toBe(buffer.byteLength);
      expect(result.attachments[0]?.content.length).toBeGreaterThan(0);
      if ((SUPPORTED_TEXT_EXTENSIONS as readonly string[]).includes(extension)) {
        expect(result.attachments[0]?.content).toContain(
          `Truncated after ${MAX_ATTACHMENT_CHARS.toLocaleString()} characters.`,
        );
      }
      await expectCompleteResourceProcessing(
        resourceFromAttachment(filename, result.attachments[0]!),
        extension,
      );
    },
    120_000,
  );

  it.each(IMAGE_CASES)(
    "accepts $label .$extension with a native image payload",
    async ({ extension, bytes }) => {
      const buffer = await largeFixture(extension, bytes);
      const filename = `large-acceptance.${extension}`;
      const result = await validateAttachments([
        {
          name: filename,
          mimeType: mimeTypeForAttachmentName(filename),
          dataBase64: buffer.toString("base64"),
          sizeBytes: 1,
        },
      ]);

      expect(result.ok, result.error).toBe(true);
      expect(result.attachments[0]).toMatchObject({
        sizeBytes: buffer.byteLength,
        kind: "image",
        extractionStatus: "metadata_only",
        runtimeContent: { type: "image" },
      });
      expect(result.attachments[0]?.image?.width).toBe(4);
      expect(result.attachments[0]?.image?.height).toBe(3);
      expect(
        Buffer.from(
          result.attachments[0]?.runtimeContent?.dataBase64 ?? "",
          "base64",
        ),
      ).toEqual(buffer);
      await expectCompleteResourceProcessing(
        resourceFromAttachment(filename, result.attachments[0]!),
        extension,
      );
    },
    120_000,
  );
});

async function largeFixture(extension: string, targetBytes: number): Promise<Buffer> {
  if ((SUPPORTED_TEXT_EXTENSIONS as readonly string[]).includes(extension)) {
    return largeTextFixture(targetBytes, extension);
  }
  if (extension === "pdf") return largePdfFixture(targetBytes);
  if (extension === "docx") {
    return padZipToSize(docxFixture(), targetBytes, "word/media/padding.bin");
  }
  if (extension === "xlsx") {
    const zip = await JSZip.loadAsync(await xlsxFixture());
    return padZipToSize(zip, targetBytes, "xl/media/padding.bin");
  }
  if (extension === "pptx") {
    return padZipToSize(pptxFixture(), targetBytes, "ppt/media/padding.bin");
  }
  if (extension === "png") return paddedPng(targetBytes);
  if (extension === "jpg" || extension === "jpeg") {
    return paddedJpeg(targetBytes);
  }
  if (extension === "webp") return paddedWebp(targetBytes);
  throw new Error(`No large fixture generator for .${extension}`);
}

function largeTextFixture(targetBytes: number, extension: string): Buffer {
  if (extension === "csv" || extension === "tsv") {
    const delimiter = extension === "tsv" ? "\t" : ",";
    const header = `id${delimiter}amount${delimiter}marker${delimiter}payload\n`;
    const rowPrefixes = MATRIX_MARKERS.map(
      (marker, index) =>
        `${index + 1}${delimiter}${(index + 1) * 11}${delimiter}${marker}${delimiter}`,
    );
    const fixedBytes =
      Buffer.byteLength(header) +
      rowPrefixes.reduce(
        (total, prefix) => total + Buffer.byteLength(prefix) + 1,
        0,
      );
    const fillerBytes = targetBytes - fixedBytes;
    const perRow = Math.floor(fillerBytes / rowPrefixes.length);
    const rows = rowPrefixes.map((prefix, index) => {
      const length =
        perRow + (index < fillerBytes % rowPrefixes.length ? 1 : 0);
      return `${prefix}${"x".repeat(length)}\n`;
    });
    return Buffer.from(`${header}${rows.join("")}`, "utf8");
  }

  const beginning = `${MATRIX_MARKERS[0]}\n`;
  const middle = `${MATRIX_MARKERS[1]}\n`;
  const end = `${MATRIX_MARKERS[2]}\n`;
  const fixedBytes =
    Buffer.byteLength(beginning) +
    Buffer.byteLength(middle) +
    Buffer.byteLength(end);
  const fillerBytes = targetBytes - fixedBytes;
  const first = Math.floor(fillerBytes / 2);
  return Buffer.from(
    `${beginning}${"a".repeat(first)}${middle}${"b".repeat(
      fillerBytes - first,
    )}${end}`,
    "utf8",
  );
}

function largePdfFixture(targetBytes: number): Buffer {
  let paddingBytes = Math.max(0, targetBytes - 4_096);
  let result = buildPdf(paddingBytes);
  for (let attempt = 0; attempt < 6 && result.length !== targetBytes; attempt += 1) {
    paddingBytes += targetBytes - result.length;
    result = buildPdf(paddingBytes);
  }
  expect(result.length).toBe(targetBytes);
  return result;
}

function buildPdf(paddingBytes: number): Buffer {
  const fontObjectId = 3 + MATRIX_MARKERS.length * 2;
  const bodies: Array<string | Buffer> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${MATRIX_MARKERS.map(
      (_marker, index) => `${3 + index * 2} 0 R`,
    ).join(" ")}] /Count ${MATRIX_MARKERS.length} >>`,
  ];
  for (const [index, marker] of MATRIX_MARKERS.entries()) {
    const contentId = 4 + index * 2;
    const stream = `BT /F1 12 Tf 72 720 Td (${marker}) Tj ET`;
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  bodies.push(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    Buffer.concat([
      Buffer.from(`<< /Length ${paddingBytes} >>\nstream\n`),
      Buffer.alloc(paddingBytes, 0x41),
      Buffer.from("\nendstream"),
    ]),
  );
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
  const xref = [
    `xref\n0 ${bodies.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n `),
    `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>`,
    `startxref\n${xrefOffset}`,
    "%%EOF\n",
  ].join("\n");
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

function docxFixture(): JSZip {
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
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${MATRIX_MARKERS.map(
      (marker) => `<w:p><w:r><w:t>${marker}</w:t></w:r></w:p>`,
    ).join("")}<w:sectPr/></w:body></w:document>`,
  );
  return zip;
}

let xlsxFixturePromise: Promise<Buffer> | undefined;
function xlsxFixture(): Promise<Buffer> {
  xlsxFixturePromise ??= (async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Large fixture");
    sheet.addRow(["id", "amount", "marker"]);
    for (const [index, marker] of MATRIX_MARKERS.entries()) {
      sheet.addRow([index + 1, (index + 1) * 11, marker]);
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
  })();
  return xlsxFixturePromise;
}

function pptxFixture(): JSZip {
  const zip = new JSZip();
  for (const [index, marker] of MATRIX_MARKERS.entries()) {
    zip.file(
      `ppt/slides/slide${index + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${marker}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
  }
  return zip;
}

function resourceFromAttachment(
  filename: string,
  attachment: PreparedChatAttachment,
): ConversationResourceArtifact {
  return {
    id: `resource-${filename}`,
    filename,
    mimeType: attachment.mimeType,
    kind: attachment.kind,
    content: attachment.storageContent,
    sizeBytes: attachment.sizeBytes,
    metadata: {
      storageEncoding: attachment.storageEncoding,
      ...(attachment.image ? { image: attachment.image } : {}),
    },
  };
}

async function expectCompleteResourceProcessing(
  resource: ConversationResourceArtifact,
  extension: string,
) {
  if (extension === "csv" || extension === "tsv" || extension === "xlsx") {
    const aggregate = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "table_aggregate",
      column: "amount",
      aggregate: "sum",
    });
    const facts = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "table_filter",
      filterColumn: "marker",
      filterOperator: "contains",
      filterValue: "DURABLE_MATRIX_FACT",
      limit: 3,
    });
    expect(aggregate).toMatchObject({
      value: 66,
      numericValues: 3,
      receipt: {
        sourceCoverage: "full",
        resultCoverage: "full",
        scannedRows: 3,
      },
    });
    const serialized = JSON.stringify(facts);
    for (const marker of MATRIX_MARKERS) expect(serialized).toContain(marker);
    return;
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
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
      image: { width: 4, height: 3, sizeBytes: resource.sizeBytes },
    });
    return;
  }

  const result = await queryConversationResource(resource, {
    resourceId: resource.id,
    operation: "search",
    query: "DURABLE_MATRIX_FACT",
    limit: 10,
  });
  expect(result.receipt).toMatchObject({
    sourceCoverage: "full",
    resultCoverage: "search_results",
  });
  const serialized = JSON.stringify(result);
  for (const marker of MATRIX_MARKERS) expect(serialized).toContain(marker);
}

async function padZipToSize(
  zip: JSZip,
  targetBytes: number,
  paddingPath: string,
): Promise<Buffer> {
  let paddingBytes = Math.max(0, targetBytes - 4_096);
  let result: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    zip.file(paddingPath, Buffer.alloc(paddingBytes, 0x41), {
      binary: true,
      compression: "STORE",
    });
    result = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 1 },
    });
    if (result.length === targetBytes) return result;
    paddingBytes += targetBytes - result.length;
  }
  expect(result.length).toBe(targetBytes);
  return result;
}

const PNG_BASE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAKElEQVR4AUzIwQ0AIAgEwZEmtUS7RPDFJZNcNuzMKdTy0ur6YR0aPAAAAP//UNkmgQAAAAZJREFUAwDkZA1b6bYozAAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG_BASE = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAADAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAeEAABAwUBAQAAAAAAAAAAAAACAwQRAAEFFCETEv/EABUBAQEAAAAAAAAAAAAAAAAAAAgJ/8QAGBEBAQEBAQAAAAAAAAAAAAAAAQIAERL/2gAMAwEAAhEDEQA/AIdlc04zOnsJtE9RsDVPUZotvoBmLn5iPofeqHJlySvFqUpVBpmYPMnDGhWnrv/Z",
  "base64",
);
const WEBP_BASE = Buffer.from(
  "UklGRj4CAABXRUJQVlA4WAoAAAAgAAAAAwAAAgAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggUAAAAPACAJ0BKgQAAwAAwBIlqAJ0ugH4AfoAEwAfiAW7M0zAAP70X+2fyZ//CmpTuiTF1GudN/99bW+s+ZcArOwFdNsP/CzP/yotzZza393/lxwA",
  "base64",
);

function paddedPng(targetBytes: number): Buffer {
  const iend = PNG_BASE.subarray(PNG_BASE.length - 12);
  const beforeIend = PNG_BASE.subarray(0, PNG_BASE.length - 12);
  const payload = Buffer.alloc(targetBytes - PNG_BASE.length - 12, 0x41);
  const type = Buffer.from("tEXt");
  const chunk = Buffer.alloc(12 + payload.length);
  chunk.writeUInt32BE(payload.length, 0);
  type.copy(chunk, 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, payload])), 8 + payload.length);
  return Buffer.concat([beforeIend, chunk, iend]);
}

function paddedJpeg(targetBytes: number): Buffer {
  const delta = targetBytes - JPEG_BASE.length;
  const segmentCount = Math.ceil(delta / 65_537);
  const minimumTotal = Math.floor(delta / segmentCount);
  const largerSegments = delta % segmentCount;
  const segments = Array.from({ length: segmentCount }, (_value, index) => {
    const total = minimumTotal + (index < largerSegments ? 1 : 0);
    if (total < 4 || total > 65_537) throw new Error("Invalid JPEG padding");
    const segment = Buffer.alloc(total, 0x41);
    segment[0] = 0xff;
    segment[1] = 0xfe;
    segment.writeUInt16BE(total - 2, 2);
    return segment;
  });
  return Buffer.concat([
    JPEG_BASE.subarray(0, JPEG_BASE.length - 2),
    ...segments,
    JPEG_BASE.subarray(JPEG_BASE.length - 2),
  ]);
}

function paddedWebp(targetBytes: number): Buffer {
  const payloadBytes = targetBytes - WEBP_BASE.length - 8;
  if (payloadBytes < 0 || payloadBytes % 2 !== 0) {
    throw new Error("WebP fixture target must allow an even metadata chunk");
  }
  const chunk = Buffer.alloc(8 + payloadBytes, 0x41);
  chunk.write("XMP ", 0, "ascii");
  chunk.writeUInt32LE(payloadBytes, 4);
  const result = Buffer.concat([WEBP_BASE, chunk]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
