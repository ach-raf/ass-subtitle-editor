export interface FieldRange {
  line: number;      // 0-based document line
  startChar: number; // 0-based column within that line
  endChar: number;   // exclusive
}

export interface ScriptInfoEntry {
  key: string;
  value: string;
  line: number;
  raw: string;             // full original line
  valueRange: FieldRange;  // range of `value` within the line
}

export interface SectionRow {
  kind: 'style' | 'dialogue' | 'comment';
  format: string[];                  // column names from the section's Format: line
  fields: Record<string, string>;    // name -> raw value
  fieldRanges: FieldRange[];         // parallel to format; range of each value
  line: number;
  raw: string;                       // full original line
  ok: boolean;                       // false if field count != format length
}

export interface AssModel {
  bom: boolean;
  crlf: boolean; // true if the source used CRLF line endings (preserved on re-emit)
  scriptInfo: ScriptInfoEntry[];
  styles: { format: string[]; rows: SectionRow[] };
  events: { format: string[]; rows: SectionRow[] };
  verbatim: { line: number; text: string }[]; // headers, Format: lines, blanks, unknown
}
