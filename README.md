# NexiPi

An extensible AI coding agent initially targeting Visual Studio Code.

## Overview

NexiPi is a modular, TypeScript-first AI coding assistant designed to integrate seamlessly with VS Code. Built with extensibility in mind, it uses a monorepo architecture to separate core logic, shared utilities, and editor-specific integrations.

## Architecture

```
nexi-pi/
├── apps/
│   └── vscode-extension/     # VS Code extension host
├── packages/
│   ├── core/                 # Core agent logic, LLM orchestration
│   ├── shared/               # Shared types, utilities, constants
│   ├── python/               # Python integrations
│   ├── docs/                 # Documentation
│   └── tests/                # End-to-end and integration tests
```

## Prerequisites

- Node.js >= 18.0.0
- pnpm >= 8.10.0
- Git

## Getting Started

### Installation

```bash
# Install dependencies
pnpm install

# Install git hooks
pnpm prepare
```

### Development

```bash
# Run all packages in development mode
pnpm dev

# Build all packages
pnpm build

# Run tests
pnpm test

# Type check all packages
pnpm typecheck

# Lint all packages
pnpm lint

# Format code
pnpm format
```

## Project Structure

### Packages

| Package          | Description                                                 |
| ---------------- | ----------------------------------------------------------- |
| `@nexipi/core`   | Core agent functionality, LLM communication, tool execution |
| `@nexipi/shared` | Shared TypeScript types, utilities, and constants           |

### Apps

| App                | Description                          |
| ------------------ | ------------------------------------ |
| `vscode-extension` | VS Code extension entry point and UI |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## License

MIT
