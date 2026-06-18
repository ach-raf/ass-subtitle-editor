import * as vscode from 'vscode';
import { AssDocument } from './assDocument';
import { AssPanel } from './assPanel';

export function activate(context: vscode.ExtensionContext): void {
  const openEditor = () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'ass') {
      vscode.window.showWarningMessage('Open an .ass file first.');
      return;
    }
    const model = new AssDocument(doc);
    context.subscriptions.push(model);
    new AssPanel(model, context);
  };
  context.subscriptions.push(vscode.commands.registerCommand('ass.openStyleEditor', openEditor));
}

export function deactivate(): void {}
