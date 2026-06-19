import type { DecodedTag } from '../assTags';
import type { RosterRow } from './roster';

export interface ScriptInfoView { key: string; value: string; line: number; }
export interface StyleRowView {
  kind: 'style'; line: number; ok: boolean;
  format: string[]; fields: Record<string, string>;
}
export interface EventDetailView {
  line: number;
  fields: Record<string, string>;
  /** Decoded override tags. Omitted on incremental patches where the Text
   *  field was not edited (the webview reuses its cached tags in that case). */
  tags?: DecodedTag[];
}

/** Host → Webview. */
export type HostToWebview =
  | { type: 'model'; bom: boolean; scriptInfo: ScriptInfoView[]; styles: { format: string[]; rows: StyleRowView[] }; events: { format: string[]; count: number } }
  | { type: 'eventsRosterBegin'; totalCount: number }
  | { type: 'eventsRosterChunk'; startIndex: number; rows: RosterRow[]; totalCount: number }
  | { type: 'eventsRosterEnd'; totalCount: number }
  | { type: 'eventDetail'; detail: EventDetailView }
  | { type: 'eventPatched'; line: number; roster: RosterRow; detail: EventDetailView };

/** Webview → Host. */
export type WebviewToHost =
  | { type: 'getEventDetail'; lines: number[] }
  | { type: 'edit'; section: string; line: number; fieldIndex: number; value: string }
  | { type: 'addRow' | 'duplicateRow' | 'deleteRow'; section: string; line?: number };
