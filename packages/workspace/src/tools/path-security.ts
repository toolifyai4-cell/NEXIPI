import type { FileStat, FileSystemProvider } from '../discovery/workspace-provider.js';
import { relativePath } from './classification.js';
import { ToolErrorCode, createToolError } from './errors.js';

function checkCancelled(signal: AbortSignal | undefined, path: string): void {
  if (signal?.aborted) {
    throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Operation cancelled', { path });
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || (error as Error & { code?: string }).code === 'ABORT_ERR';
  }
  return false;
}

/**
 * Validates every component from the workspace root to the requested target
 * without following symbolic links.
 *
 * The workspace root itself, every intermediate directory, and the final
 * target component are each inspected with `lstat`. If any component is a
 * symbolic link the operation is rejected. If any component cannot be
 * reliably inspected the operation fails closed.
 *
 * The caller must have already enforced the lexical workspace boundary
 * (the target must resolve beneath `root`); this function performs no lexical
 * boundary check of its own.
 *
 * Components are inspected in root-to-target order. Because each parent is
 * validated before it is ever used as a `readDirectory` parent by the
 * provider, a symlinked ancestor is detected before any lookup could follow
 * it.
 *
 * Returns the `lstat` result of the final target component.
 */
export async function validateSymlinkFreePath(
  fileSystem: FileSystemProvider,
  root: string,
  absPath: string,
  signal: AbortSignal | undefined
): Promise<FileStat> {
  let current = root;
  let stat: FileStat = await inspectComponent(fileSystem, current, signal);

  const rel = relativePath(root, absPath);
  const components = rel === undefined || rel === '' ? [] : rel.split('/');

  for (const component of components) {
    current = `${current}/${component}`;
    stat = await inspectComponent(fileSystem, current, signal);
  }

  return stat;
}

async function inspectComponent(
  fileSystem: FileSystemProvider,
  path: string,
  signal: AbortSignal | undefined
): Promise<FileStat> {
  checkCancelled(signal, path);

  let stat: FileStat;
  try {
    stat = await fileSystem.lstat(path);
  } catch (error) {
    if (isAbortError(error)) {
      throw createToolError(ToolErrorCode.TOOL_CANCELLED, 'Operation cancelled', { path });
    }
    const message = error instanceof Error ? error.message : String(error);
    const isNotFound =
      (error as Error & { code?: string }).code === 'ENOENT' ||
      message.includes('ENOENT');
    if (isNotFound) {
      throw createToolError(ToolErrorCode.TOOL_FILE_NOT_FOUND, `Path not found: ${message}`, { path });
    }
    // Fail closed: the provider cannot verify this component is not a symlink.
    throw createToolError(
      ToolErrorCode.TOOL_FILESYSTEM_ERROR,
      `Unable to resolve path safely: ${message}`,
      { path }
    );
  }

  if (stat.type === 'symbolicLink') {
    throw createToolError(
      ToolErrorCode.TOOL_SYMLINK_NOT_ALLOWED,
      'Symbolic links are not allowed',
      { path }
    );
  }

  return stat;
}
