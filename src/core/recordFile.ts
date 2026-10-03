// Kifu file import/export. The extension → format/encoding mapping and the
// buffer import/export follow ShogiHome src/common/file/record.ts
// (MIT, (c) 2022 Kubo Ryosuke); content sniffing for pasted text is ours.
import {
  ImmutableRecord,
  Record,
  RecordFormatType,
  detectRecordFormat,
  exportCSA,
  exportKI2,
  exportKIF,
  exportJKFString,
  importCSA,
  importKI2,
  importKIF,
  importJKFString,
} from "tsshogi";
import { decodeText, encodeText } from "./encode.js";

export enum RecordFileFormat {
  KIF = ".kif",
  KIFU = ".kifu",
  KI2 = ".ki2",
  KI2U = ".ki2u",
  CSA = ".csa",
  SFEN = ".sfen",
  JKF = ".jkf",
}

export function detectRecordFileFormatByPath(path: string): RecordFileFormat | undefined {
  const lowerCase = path.toLowerCase();
  for (const ext of Object.values(RecordFileFormat)) {
    if (lowerCase.endsWith(ext)) {
      return ext;
    }
  }
}

function getRecommendedEncodingByFileFormat(format: RecordFileFormat): "UTF8" | "SJIS" {
  switch (format) {
    default:
      return "UTF8";
    case RecordFileFormat.KIF:
    case RecordFileFormat.KI2:
      return "SJIS";
  }
}

/** Parse kifu text of any supported format (KIF, KI2, CSA, JKF, USI, SFEN, USEN). */
export function importRecordFromText(text: string): Record | Error {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (!trimmed) {
    return new Error("empty input");
  }
  switch (detectRecordFormat(trimmed)) {
    case RecordFormatType.KIF:
      return importKIF(trimmed);
    case RecordFormatType.KI2:
      return importKI2(trimmed);
    case RecordFormatType.CSA:
      return importCSA(trimmed);
    case RecordFormatType.JKF:
      return importJKFString(trimmed);
    case RecordFormatType.USEN:
      return Record.newByUSEN(trimmed);
    case RecordFormatType.USI:
    case RecordFormatType.SFEN:
      return Record.newByUSI(trimmed);
  }
  return new Error("unknown record format");
}

/**
 * Import a kifu file. The file name picks the default encoding (Shift_JIS for
 * .kif/.ki2, UTF-8 otherwise) and the text encoding is auto-detected, as in
 * ShogiHome. The format is taken from the extension when there is one and
 * sniffed from the content otherwise.
 */
export function importRecordFromBuffer(data: Uint8Array, fileName = ""): Record | Error {
  const format = detectRecordFileFormatByPath(fileName);
  const text = decodeText(data, {
    encoding: format ? getRecommendedEncodingByFileFormat(format) : "UTF8",
    autoDetect: true,
  });
  switch (format) {
    case RecordFileFormat.KIF:
    case RecordFileFormat.KIFU:
      return importKIF(text);
    case RecordFileFormat.KI2:
    case RecordFileFormat.KI2U:
      return importKI2(text);
    case RecordFileFormat.CSA:
      return importCSA(text);
    case RecordFileFormat.JKF:
      return importJKFString(text);
    default:
      return importRecordFromText(text);
  }
}

export type ExportResult = {
  data: Uint8Array;
  text: string;
  garbled: boolean;
};

export function exportRecordAsBuffer(
  record: ImmutableRecord,
  format: RecordFileFormat,
  opt: { utf8?: boolean; returnCode?: string } = {},
): ExportResult {
  const encoding =
    opt.utf8 && (format === RecordFileFormat.KIF || format === RecordFileFormat.KI2)
      ? "UTF8"
      : getRecommendedEncodingByFileFormat(format);
  const returnCode = opt.returnCode ?? "\r\n";
  let text: string;
  switch (format) {
    case RecordFileFormat.KIF:
    case RecordFileFormat.KIFU:
      text = exportKIF(record, { returnCode });
      break;
    case RecordFileFormat.KI2:
    case RecordFileFormat.KI2U:
      text = exportKI2(record, { returnCode });
      break;
    case RecordFileFormat.CSA:
      text = exportCSA(record, { returnCode });
      break;
    case RecordFileFormat.JKF:
      text = exportJKFString(record);
      break;
    case RecordFileFormat.SFEN:
      text = record.usi + "\n";
      break;
  }
  const data = encodeText(text, encoding);
  let garbled = false;
  if (encoding === "SJIS") {
    garbled = decodeText(data, { encoding: "SJIS" }) !== text;
  }
  return { data, text, garbled };
}
