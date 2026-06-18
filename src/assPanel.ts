import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { AssDocument } from './assDocument';
import { computeFieldEdit, computeScriptInfoEdit, rowStillValid } from './assEdit';
import { decodeDialogueTags } from './assTags';
import type { AssModel, SectionRow } from './types';

function stripRow(r: SectionRow) {
  return { kind: r.kind, line: r.line, ok: r.ok, format: r.format, fields: r.fields };
}

export class AssPanel {
  private panel: vscode.WebviewPanel;
  private doc: AssDocument;
  private rowsByLine = new Map<number, SectionRow>();
  private _onDidDispose = new vscode.EventEmitter<void>();
  /** Fires when the underlying webview panel is disposed. */
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
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );
    this.panel.webview.html = this.html(this.panel.webview, context);
    this.doc.onModelChange = (m) => this.send(m);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.panel.onDidDispose(() => {
      this.doc.onModelChange = () => {};
      this._onDidDispose.fire();
    });
    this.send(doc.model);
  }

  /** Reveal the panel in its column. */
  reveal(): void {
    this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside, false);
  }

  private send(model: AssModel): void {
    this.reindex(model);
    const view = {
      bom: model.bom,
      scriptInfo: model.scriptInfo.map((e) => ({ key: e.key, value: e.value, line: e.line })),
      styles: { format: model.styles.format, rows: model.styles.rows.map(stripRow) },
      events: {
        format: model.events.format,
        rows: model.events.rows.map((r) => ({ ...stripRow(r), tags: decodeDialogueTags(r.fields.Text ?? '') })),
      },
    };
    this.panel.webview.postMessage({ type: 'model', model: view });
  }

  private reindex(model: AssModel): void {
    this.rowsByLine.clear();
    for (const r of [...model.styles.rows, ...model.events.rows]) this.rowsByLine.set(r.line, r);
  }

  private async onMessage(msg: { type: string; section?: string; line?: number; fieldIndex?: number; value?: string }): Promise<void> {
    // A single malformed message must never wedge the panel: any failure
    // logs a warning and refreshes the model (re-renders the webview) rather
    // than letting the exception escape the message handler.
    try {
      if (msg.type === 'edit') await this.onEdit(msg);
      if (msg.type === 'addRow' && msg.section === 'styles') return this.insertStyle(msg.line);
      if (msg.type === 'duplicateRow' && msg.section === 'styles' && msg.line != null) return this.duplicateStyle(this.clampLine(msg.line));
      if (msg.type === 'deleteRow' && msg.section === 'styles' && msg.line != null) return this.deleteStyle(this.clampLine(msg.line));
    } catch (err) {
      console.warn('AssPanel onMessage error:', err);
      this.doc.refresh();
    }
  }

  // Clamp an inbound line number to a valid `lineAt` index so a stale message
  // (e.g. a row that was just deleted) cannot throw out of range.
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
    this.doc.refresh(); // Critical #1: collapse stale-window immediately
  }
  private async insertLine(line: number, text: string): Promise<void> {
    const ws = new vscode.WorkspaceEdit();
    ws.insert(this.doc.doc.uri, new vscode.Position(line, 0), text + '\n');
    await vscode.workspace.applyEdit(ws);
    this.doc.refresh(); // Critical #1: collapse stale-window immediately
  }

  private async onEdit(msg: { section?: string; line?: number; fieldIndex?: number; value?: string }): Promise<void> {
    if (msg.section === 'scriptInfo') {
      if (msg.line == null) return;
      const entry = this.doc.model.scriptInfo.find((e) => e.line === msg.line);
      if (!entry) return;
      // Critical #2: stale-guard for Script Info edits — mirror the section-row
      // discipline. If the live value slice no longer matches the stored range,
      // the parse is stale; refresh and abort instead of mis-targeting.
      const ln = this.clampLine(msg.line);
      const live = this.doc.doc.lineAt(ln).text;
      if (live.slice(entry.valueRange.startChar, entry.valueRange.endChar) !== entry.value) {
        this.doc.refresh();
        return;
      }
      const e = computeScriptInfoEdit(entry, msg.value ?? '');
      const ws = new vscode.WorkspaceEdit();
      ws.replace(this.doc.doc.uri, new vscode.Range(e.line, e.startChar, e.line, e.endChar), e.newContent);
      await vscode.workspace.applyEdit(ws);
      this.doc.refresh(); // Critical #1: collapse stale-window immediately
      return;
    }
    if (msg.line == null || msg.fieldIndex == null) return;
    const ln = this.clampLine(msg.line);
    const row = this.rowsByLine.get(msg.line);
    if (!row) return;
    // Stale-parse guard: confirm the live line still matches (kept as defense
    // for external text-edit races; refresh() above covers our own edits).
    const liveLine = this.doc.doc.lineAt(ln).text;
    if (!rowStillValid(liveLine, row)) { this.doc.refresh(); return; }
    const edit = computeFieldEdit(row, msg.fieldIndex, msg.value ?? '');
    if (!edit) return;
    const ws = new vscode.WorkspaceEdit();
    ws.replace(this.doc.doc.uri, new vscode.Range(edit.line, edit.startChar, edit.line, edit.endChar), edit.newContent);
    await vscode.workspace.applyEdit(ws);
    this.doc.refresh(); // Critical #1: collapse stale-window immediately
  }

  private html(webview: vscode.Webview, context: vscode.ExtensionContext): string {
    const nonce = getNonce();
    const js = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'panel.js'));
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
  // Use a CSPRNG per VS Code webview convention; Math.random is not suitable
  // for the Content-Security-Policy nonce.
  return randomBytes(16).toString('hex');
}
