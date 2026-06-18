import * as vscode from 'vscode';
import { AssDocument } from './assDocument';
import { AssPanel } from './assPanel';

// One live panel (and one live AssDocument listener) per document URI.
// Re-running the command on an already-open document reveals the existing
// panel instead of leaking a new AssDocument + AssPanel each time.
const panelsByKey = new Map<string, AssPanel>();

export function activate(context: vscode.ExtensionContext): void {
  const openEditor = () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'ass') {
      vscode.window.showWarningMessage('Open an .ass file first.');
      return;
    }
    const key = doc.uri.toString();
    const existing = panelsByKey.get(key);
    if (existing) {
      existing.reveal();
      return;
    }
    const model = new AssDocument(doc);
    context.subscriptions.push(model);
    const panel = new AssPanel(model, context);
    panelsByKey.set(key, panel);
    panel.onDidDispose(() => {
      panelsByKey.delete(key);
      model.dispose();
    });
  };
  context.subscriptions.push(vscode.commands.registerCommand('ass.openStyleEditor', openEditor));
}

export function deactivate(): void {}
