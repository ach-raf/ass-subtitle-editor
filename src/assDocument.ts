import * as vscode from 'vscode';
import { parseAss } from './assParser';
import type { AssModel } from './types';

export class AssDocument {
  readonly doc: vscode.TextDocument;
  private _model: AssModel;
  private _disposables: vscode.Disposable[] = [];
  private _timer: NodeJS.Timeout | undefined;
  onModelChange: (m: AssModel) => void = () => {};

  constructor(doc: vscode.TextDocument) {
    this.doc = doc;
    this._model = parseAss(doc.getText());
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === this.doc) this.schedule();
    });
    this._disposables.push(sub);
  }

  get model(): AssModel {
    return this._model;
  }

  refresh(): void {
    this._model = parseAss(this.doc.getText());
    this.onModelChange(this._model);
  }

  private schedule(): void {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.refresh(), 200);
  }

  dispose(): void {
    if (this._timer) clearTimeout(this._timer);
    this._disposables.forEach((d) => d.dispose());
  }
}
