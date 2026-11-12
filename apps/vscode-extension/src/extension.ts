import * as vscode from 'vscode';
import { defaultConfig } from '@nexipi/core';

export function activate(context: vscode.ExtensionContext): void {
  console.log(`[${defaultConfig.name}] Extension activated v${defaultConfig.version}`);

  const disposable = vscode.commands.registerCommand('nexipi.hello', () => {
    vscode.window.showInformationMessage(`Hello from ${defaultConfig.name}!`);
  });

  context.subscriptions.push(disposable);
}

export function deactivate(): void {
  console.log(`[${defaultConfig.name}] Extension deactivated`);
}