import * as vscode from 'vscode';
import { AssDocument } from './assDocument';
import { computeFieldEdit, rowStillValid } from './assEdit';
import type { AssModel, SectionRow } from './types';

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
    this.panel.webview.postMessage({ type: 'model', model });
  }

  private reindex(model: AssModel): void {
    this.rowsByLine.clear();
    for (const r of [...model.styles.rows, ...model.events.rows]) this.rowsByLine.set(r.line, r);
  }

  private async onMessage(msg: { type: string; section?: string; line?: number; fieldIndex?: number; value?: string }): Promise<void> {
    if (msg.type === 'edit') await this.onEdit(msg);
    // addRow / duplicateRow / deleteRow dispatch added in Task 10.
  }

  private async onEdit(msg: { section?: string; line?: number; fieldIndex?: number; value?: string }): Promise<void> {
    if (msg.section === 'scriptInfo' || msg.line == null || msg.fieldIndex == null) return; // scriptInfo handled in Task 9
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
