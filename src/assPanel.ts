import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { AssDocument } from './assDocument';
import { computeFieldEdit, computeScriptInfoEdit, rowStillValid } from './assEdit';
import { decodeDialogueTags } from './assTags';
import { renderRuns, resolveBaseStyle, resolveStyleRow } from './assRender';
import { buildRosterRow, chunkRoster } from './shared/roster';
import type { EventDetailView } from './shared/messages';
import type { AssModel, SectionRow } from './types';

const ROSTER_CHUNK_SIZE = 2000;

function stripStyleRow(r: SectionRow) {
  return { kind: r.kind, line: r.line, ok: r.ok, format: r.format, fields: r.fields };
}

export class AssPanel {
  private panel: vscode.WebviewPanel;
  private doc: AssDocument;
  private rowsByLine = new Map<number, SectionRow>();
  /** document.version captured after the panel last synced its own edit. Used to
   *  tell our own WorkspaceEdit apart from an external text-editor change. */
  private lastSyncedVersion = 0;
  private _onDidDispose = new vscode.EventEmitter<void>();
  readonly onDidDispose = this._onDidDispose.event;

  constructor(doc: AssDocument, context: vscode.ExtensionContext) {
    this.doc = doc;
    this.panel = vscode.window.createWebviewPanel(
      'assStyleEditor',
      `ASS Editor — ${vscode.workspace.asRelativePath(doc.doc.uri)}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media'),
          vscode.Uri.joinPath(context.extensionUri, 'dist'),
        ],
      },
    );
    this.panel.webview.html = this.html(this.panel.webview, context);
    this.doc.onChanged = () => this.onExternalChange();
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.panel.onDidDispose(() => {
      this.doc.onChanged = () => {};
      this._onDidDispose.fire();
    });
    this.initialSend();
  }

  reveal(): void {
    this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside, false);
  }

  /** First paint: small model + full roster (chunked). */
  private initialSend(): void {
    this.reindex(this.doc.model);
    this.lastSyncedVersion = this.doc.doc.version;
    this.sendModel();
    this.sendRoster(this.doc.model);
  }

  /** External (non-panel) text change: version differs → full resync. */
  private onExternalChange(): void {
    if (this.doc.doc.version === this.lastSyncedVersion) return; // our own edit
    this.doc.refresh();
    this.reindex(this.doc.model);
    this.lastSyncedVersion = this.doc.doc.version;
    this.sendModel();
    this.sendRoster(this.doc.model);
  }

  private reindex(model: AssModel): void {
    this.rowsByLine.clear();
    for (const r of [...model.styles.rows, ...model.events.rows]) this.rowsByLine.set(r.line, r);
  }

  /** Small model: Script Info + full Styles + the Events header (format + count). */
  private sendModel(): void {
    const m = this.doc.model;
    this.panel.webview.postMessage({
      type: 'model',
      bom: m.bom,
      scriptInfo: m.scriptInfo.map((e) => ({ key: e.key, value: e.value, line: e.line })),
      styles: { format: m.styles.format, rows: m.styles.rows.map(stripStyleRow) },
      events: { format: m.events.format, count: m.events.rows.length },
    });
  }

  /** Full events roster, sent in pages so the webview paints progressively. */
  private sendRoster(model: AssModel): void {
    const roster = model.events.rows.map(buildRosterRow);
    const total = roster.length;
    this.panel.webview.postMessage({ type: 'eventsRosterBegin', totalCount: total });
    let offset = 0;
    for (const page of chunkRoster(roster, ROSTER_CHUNK_SIZE)) {
      this.panel.webview.postMessage({
        type: 'eventsRosterChunk',
        startIndex: offset, // index of `rows[0]` within the full roster
        rows: page,
        totalCount: total,
      });
      offset += page.length;
    }
    this.panel.webview.postMessage({ type: 'eventsRosterEnd', totalCount: total });
  }

  /** Resolve the base style for an event row and render its preview runs.
   *  baseFontSize is sent alongside so the webview can scale ASS px → row px. */
  private renderFor(row: SectionRow): { runs: ReturnType<typeof renderRuns>; baseFontSize: number } {
    const base = resolveBaseStyle(resolveStyleRow(this.doc.model, row.fields.Style));
    return { runs: renderRuns(row.fields.Text ?? '', base), baseFontSize: base.fontSize ?? 48 };
  }

  /** Respond to expanded-row detail requests (decoded tags + preview runs). */
  private sendDetails(lines: number[]): void {
    for (const line of lines) {
      const row = this.rowsByLine.get(line);
      if (!row) continue;
      const { runs, baseFontSize } = this.renderFor(row);
      this.panel.webview.postMessage({
        type: 'eventDetail',
        detail: {
          line,
          fields: { ...row.fields },
          tags: decodeDialogueTags(row.fields.Text ?? ''),
          runs,
          baseFontSize,
        },
      });
    }
  }

  /** After a panel-initiated event edit: patch one row, not the whole roster.
   *  Tag chips / runs can only change when the Text field was edited — for any
   *  other field skip the (relatively costly) decode and let the webview reuse
   *  what its detail cache already holds (tags/runs omitted from the message). */
  private sendEventPatch(line: number, editedField?: string): void {
    const row = this.rowsByLine.get(line);
    if (!row) return;
    const fields = { ...row.fields };
    const detail: EventDetailView = { line, fields };
    if (editedField === 'Text') {
      detail.tags = decodeDialogueTags(row.fields.Text ?? '');
      const { runs, baseFontSize } = this.renderFor(row);
      detail.runs = runs;
      detail.baseFontSize = baseFontSize;
    }
    this.panel.webview.postMessage({
      type: 'eventPatched',
      line,
      roster: buildRosterRow(row),
      detail,
    });
  }

  private async onMessage(msg: { type: string; section?: string; line?: number; fieldIndex?: number; value?: string; lines?: number[] }): Promise<void> {
    try {
      if (msg.type === 'edit') return await this.onEdit(msg);
      if (msg.type === 'getEventDetail' && Array.isArray(msg.lines)) return this.sendDetails(msg.lines);
      if (msg.type === 'addRow' && msg.section === 'styles') return this.insertStyle(msg.line);
      if (msg.type === 'duplicateRow' && msg.section === 'styles' && msg.line != null) return this.duplicateStyle(this.clampLine(msg.line));
      if (msg.type === 'deleteRow' && msg.section === 'styles' && msg.line != null) return this.deleteStyle(this.clampLine(msg.line));
    } catch (err) {
      console.warn('AssPanel onMessage error:', err);
      this.onExternalChange(); // recover by full resync
    }
  }

  private clampLine(line: number): number {
    if (!Number.isFinite(line) || line < 0) return 0;
    return Math.min(line, this.doc.doc.lineCount - 1);
  }

  private async insertStyle(afterLine?: number): Promise<void> {
    const rows = this.doc.model.styles.rows;
    const template = rows[rows.length - 1];
    const lineNo = afterLine != null ? this.clampLine(afterLine) : (template?.line ?? this.doc.doc.lineCount - 1);
    const text = template
      ? template.raw
      : 'Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,20,1';
    await this.insertLine(lineNo + 1, text);
  }
  private async duplicateStyle(line: number): Promise<void> {
    const row = this.rowsByLine.get(line);
    if (row) await this.insertLine(line + 1, row.raw);
  }
  private async deleteStyle(line: number): Promise<void> {
    const ws = new vscode.WorkspaceEdit();
    ws.delete(this.doc.doc.uri, this.doc.doc.lineAt(line).rangeIncludingLineBreak);
    await vscode.workspace.applyEdit(ws);
    this.afterStructuralChange();
  }
  private async insertLine(line: number, text: string): Promise<void> {
    const ws = new vscode.WorkspaceEdit();
    ws.insert(this.doc.doc.uri, new vscode.Position(line, 0), text + '\n');
    await vscode.workspace.applyEdit(ws);
    this.afterStructuralChange();
  }

  /** Style add/dup/delete shifts event line numbers → resync model + roster. */
  private afterStructuralChange(): void {
    this.doc.refresh();
    this.reindex(this.doc.model);
    this.lastSyncedVersion = this.doc.doc.version;
    this.sendModel();
    this.sendRoster(this.doc.model);
  }

  private async onEdit(msg: { section?: string; line?: number; fieldIndex?: number; value?: string }): Promise<void> {
    if (msg.section === 'scriptInfo') {
      if (msg.line == null) return;
      const entry = this.doc.model.scriptInfo.find((e) => e.line === msg.line);
      if (!entry) return;
      const ln = this.clampLine(msg.line);
      const live = this.doc.doc.lineAt(ln).text;
      if (live.slice(entry.valueRange.startChar, entry.valueRange.endChar) !== entry.value) {
        this.onExternalChange();
        return;
      }
      const e = computeScriptInfoEdit(entry, msg.value ?? '');
      const ws = new vscode.WorkspaceEdit();
      ws.replace(this.doc.doc.uri, new vscode.Range(e.line, e.startChar, e.line, e.endChar), e.newContent);
      await vscode.workspace.applyEdit(ws);
      this.afterFieldEdit();
      return;
    }
    if (msg.section === 'styles') {
      if (msg.line == null || msg.fieldIndex == null) return;
      const ln = this.clampLine(msg.line);
      const row = this.rowsByLine.get(msg.line);
      if (!row) return;
      const liveLine = this.doc.doc.lineAt(ln).text;
      if (!rowStillValid(liveLine, row)) { this.onExternalChange(); return; }
      const edit = computeFieldEdit(row, msg.fieldIndex, msg.value ?? '');
      if (!edit) return;
      const ws = new vscode.WorkspaceEdit();
      ws.replace(this.doc.doc.uri, new vscode.Range(edit.line, edit.startChar, edit.line, edit.endChar), edit.newContent);
      await vscode.workspace.applyEdit(ws);
      this.afterFieldEdit(); // style field edits don't shift event lines
      return;
    }
    // events
    if (msg.line == null || msg.fieldIndex == null) return;
    const ln = this.clampLine(msg.line);
    const row = this.rowsByLine.get(msg.line);
    if (!row) return;
    const liveLine = this.doc.doc.lineAt(ln).text;
    if (!rowStillValid(liveLine, row)) { this.onExternalChange(); return; }
    const edit = computeFieldEdit(row, msg.fieldIndex, msg.value ?? '');
    if (!edit) return;
    const ws = new vscode.WorkspaceEdit();
    ws.replace(this.doc.doc.uri, new vscode.Range(edit.line, edit.startChar, edit.line, edit.endChar), edit.newContent);
    await vscode.workspace.applyEdit(ws);
    // Event field edits never change line count → sync this one row only.
    this.doc.refresh();
    this.reindex(this.doc.model);
    this.lastSyncedVersion = this.doc.doc.version;
    this.sendModel();
    this.sendEventPatch(msg.line, row.format[msg.fieldIndex]);
  }

  /** Script Info / Style field edit: model changed, line numbers did not. */
  private afterFieldEdit(): void {
    this.doc.refresh();
    this.reindex(this.doc.model);
    this.lastSyncedVersion = this.doc.doc.version;
    this.sendModel();
  }

  private html(webview: vscode.Webview, context: vscode.ExtensionContext): string {
    const nonce = getNonce();
    const js = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'panel.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'panel.css'));
    return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<link rel="stylesheet" href="${css}" />
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  return randomBytes(16).toString('hex');
}
