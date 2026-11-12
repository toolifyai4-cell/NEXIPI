import * as vscode from 'vscode';
import { defaultConfig } from '@nexipi/core';
import type { Logger, LogLevel } from '@nexipi/shared';

interface NexiPiContext {
  outputChannel: vscode.OutputChannel;
  statusBarItem: vscode.StatusBarItem;
  logger: Logger;
  disposables: vscode.Disposable[];
}

function createLogger(outputChannel: vscode.OutputChannel, level: LogLevel): Logger {
  const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const currentLevel = levels[level];

  const log = (messageLevel: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (levels[messageLevel] >= currentLevel) {
      const timestamp = new Date().toISOString();
      const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
      outputChannel.appendLine(
        `[${timestamp}] [${messageLevel.toUpperCase()}] ${message}${metaStr}`
      );
    }
  };

  return {
    debug: (message: string, meta?: Record<string, unknown>) => log('debug', message, meta),
    info: (message: string, meta?: Record<string, unknown>) => log('info', message, meta),
    warn: (message: string, meta?: Record<string, unknown>) => log('warn', message, meta),
    error: (message: string, meta?: Record<string, unknown>) => log('error', message, meta),
  };
}

function createStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'nexipi.showOutput';
  item.tooltip = 'Click to open NexiPi output channel';
  item.text = '$(plug) NexiPi: Initializing...';
  item.show();
  return item;
}

function updateStatusBar(
  statusBarItem: vscode.StatusBarItem,
  status: 'initializing' | 'active' | 'error',
  message?: string
): void {
  const icons = { initializing: '$(loading~spin)', active: '$(plug)', error: '$(error)' };
  const texts = {
    initializing: 'NexiPi: Initializing...',
    active: 'NexiPi: Active',
    error: 'NexiPi: Error',
  };
  statusBarItem.text = `${icons[status]} ${texts[status]}${message ? ` - ${message}` : ''}`;
}

function registerCommands(
  context: vscode.ExtensionContext,
  nexipiContext: NexiPiContext,
  config: vscode.WorkspaceConfiguration
): vscode.Disposable[] {
  const { outputChannel, statusBarItem, logger } = nexipiContext;
  const disposables: vscode.Disposable[] = [];

  const startDisposable = vscode.commands.registerCommand('nexipi.start', async () => {
    logger.info('Command executed: nexipi.start');
    updateStatusBar(statusBarItem, 'initializing');

    try {
      const enabled = config.get<boolean>('nexipi.enabled', true);
      if (!enabled) {
        logger.warn('NexiPi is disabled via configuration');
        void vscode.window.showWarningMessage(
          'NexiPi is disabled. Enable it in settings to start.'
        );
        updateStatusBar(statusBarItem, 'error', 'Disabled');
        return;
      }

      logger.info('Starting NexiPi...');
      await new Promise(resolve => setTimeout(resolve, 100));

      logger.info('NexiPi started successfully');
      updateStatusBar(statusBarItem, 'active');
      void vscode.window.showInformationMessage('NexiPi started successfully');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to start NexiPi', { error: err.message });
      updateStatusBar(statusBarItem, 'error', err.message);
      void vscode.window.showErrorMessage(`Failed to start NexiPi: ${err.message}`);
    }
  });

  const showOutputDisposable = vscode.commands.registerCommand('nexipi.showOutput', () => {
    logger.info('Command executed: nexipi.showOutput');
    outputChannel.show();
  });

  const showInformationDisposable = vscode.commands.registerCommand(
    'nexipi.showInformation',
    () => {
      logger.info('Command executed: nexipi.showInformation');
      const info = [
        `NexiPi v${defaultConfig.version}`,
        'Extensible AI coding agent for VS Code',
        '',
        'Commands:',
        '  nexipi.start - Initialize and start NexiPi',
        '  nexipi.showOutput - Show the output channel',
        '  nexipi.showInformation - Show this information',
      ].join('\n');
      void vscode.window.showInformationMessage(info, { modal: true });
    }
  );

  disposables.push(startDisposable, showOutputDisposable, showInformationDisposable);
  return disposables;
}

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration('nexipi');
  const logLevel = config.get<LogLevel>('nexipi.logLevel', 'info');

  const outputChannel = vscode.window.createOutputChannel('NexiPi');
  const logger = createLogger(outputChannel, logLevel);
  const statusBarItem = createStatusBarItem();

  logger.info(`Extension activating v${defaultConfig.version}`);
  outputChannel.appendLine(
    `[${new Date().toISOString()}] [INFO] NexiPi extension activating v${defaultConfig.version}`
  );

  const nexipiContext: NexiPiContext = {
    outputChannel,
    statusBarItem,
    logger,
    disposables: [],
  };

  const commandDisposables = registerCommands(context, nexipiContext, config);
  nexipiContext.disposables.push(...commandDisposables);

  const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('nexipi')) {
      const newConfig = vscode.workspace.getConfiguration('nexipi');
      const newLogLevel = newConfig.get<LogLevel>('nexipi.logLevel', 'info');
      logger.info('Configuration changed', { logLevel: newLogLevel });
    }
  });
  nexipiContext.disposables.push(configChangeDisposable);

  nexipiContext.disposables.push(outputChannel, statusBarItem, ...commandDisposables);

  context.subscriptions.push(...nexipiContext.disposables);

  logger.info('Extension activated successfully');
  updateStatusBar(statusBarItem, 'active');
}

export function deactivate(): void {
  const outputChannel = vscode.window.createOutputChannel('NexiPi');
  outputChannel.appendLine(`[${new Date().toISOString()}] [INFO] NexiPi extension deactivated`);
  outputChannel.dispose();
}
