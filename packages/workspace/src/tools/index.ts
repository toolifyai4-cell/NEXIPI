export {
  ToolErrorCode,
  ToolError,
  createToolError,
  isToolError,
  isToolErrorCode,
  type ToolErrorOptions,
} from './errors.js';

export {
  FileReadConfig,
  defaultFileReadConfig,
  validateFileReadConfig,
  safeValidateFileReadConfig,
  DirectoryListConfig,
  defaultDirectoryListConfig,
  validateDirectoryListConfig,
  safeValidateDirectoryListConfig,
} from './config.js';

export {
  ToolKind,
  ReadFileOptions,
  ReadFileResult,
  ListDirectoryOptions,
  ListDirectoryResult,
  DirectoryListingEntry,
  SearchContextLine,
  SearchMatch,
  SearchFileResult,
  CodeSearchOptions,
  CodeSearchResult,
  type ToolResult,
} from './contracts.js';

export {
  ReadFileInput,
  ListDirectoryInput,
  validateReadFileInput,
  safeValidateReadFileInput,
  validateListDirectoryInput,
  safeValidateListDirectoryInput,
} from './schemas.js';

export {
  detectLanguage,
  isBinaryExtension,
  isSensitiveFileName,
  isBinaryContent,
  splitNameExtension,
  computeWorkspaceId,
  matchesIncludePatterns,
} from './classification.js';

export {
  CodeSearchConfig,
  defaultCodeSearchConfig,
  validateCodeSearchConfig,
  safeValidateCodeSearchConfig,
} from './search-config.js';

export {
  CodeSearchInput,
  validateCodeSearchInput,
  safeValidateCodeSearchInput,
} from './search-schemas.js';

export { FileReader, createFileReader } from './reader.js';
export { DirectoryLister, createDirectoryLister } from './lister.js';
export { CodeSearcher, createCodeSearcher } from './searcher.js';
