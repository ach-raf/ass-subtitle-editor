import * as vscode from 'vscode';
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
    this.panel.onDidDispose(() => { this.doc.onModelChange = () => {}; });
    this.send(doc.model);
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
    if (msg.type === 'edit') await this.onEdit(msg);
    if (msg.type === 'addRow' && msg.section === 'styles') return this.insertStyle(msg.line);
    if (msg.type === 'duplicateRow' && msg.section === 'styles' && msg.line != null) return this.duplicateStyle(msg.line);
    if (msg.type === 'deleteRow' && msg.section === 'styles' && msg.line != null) return this.deleteStyle(msg.line);
  }

  private async insertStyle(afterLine?: number): Promise<void> {
    const rows = this.doc.model.styles.rows;
    const template = rows[rows.length - 1];
    const lineNo = afterLine ?? template?.line ?? this.doc.doc.lineCount - 1;
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
  }
  private async insertLine(line: number, text: string): Promise<void> {
    const ws = new vscode.WorkspaceEdit();
    ws.insert(this.doc.doc.uri, new vscode.Position(line, 0), text + '\n');
    await vscode.workspace.applyEdit(ws);
  }

  private async onEdit(msg: { section?: string; line?: number; fieldIndex?: number; value?: string }): Promise<void> {
    if (msg.section === 'scriptInfo') {
      if (msg.line == null) return;
      const entry = this.doc.model.scriptInfo.find((e) => e.line === msg.line);
      if (!entry) return;
      const e = computeScriptInfoEdit(entry, msg.value ?? '');
      const ws = new vscode.WorkspaceEdit();
      ws.replace(this.doc.doc.uri, new vscode.Range(e.line, e.startChar, e.line, e.endChar), e.newContent);
      await vscode.workspace.applyEdit(ws);
      return;
    }
    if (msg.line == null || msg.fieldIndex == null) return;
    const row = this.rowsByLine.get(msg.line);
    if (!row) return;
    // Stale-parse guard: confirm the live line still matches.
    const liveLine = this.doc.doc.lineAt(msg.line).text;
    if (!rowStillValid(liveLine, row)) { this.doc.refresh(); return; }
    const edit = computeFieldEdit(row, msg.fieldIndex, msg.value ?? '');
    if (!edit) return;
    const ws = new vscode.WorkspaceEdit();
    ws.replace(this.doc.doc.uri, new vscode.Range(edit.line, edit.startChar, edit.line, edit.endChar), edit.newContent);
    await vscode.workspace.applyEdit(ws);
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
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}
