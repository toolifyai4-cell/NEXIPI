# NexiPi

<p align="center">
  <img src="LOGO/NexiPi%20Teal%20Ribbon%20Icon.png" alt="NexiPi Logo" width="140">
</p>

<p align="center">
  <strong>An extensible, modular AI coding agent for Visual Studio Code</strong>
</p>

<p align="center">
  <a href="#-features"><strong>Features</strong></a> •
  <a href="#-architecture"><strong>Architecture</strong></a> •
  <a href="#-quick-start"><strong>Quick Start</strong></a> •
  <a href="#-packages"><strong>Packages</strong></a> •
  <a href="#-development"><strong>Development</strong></a> •
  <a href="#-configuration"><strong>Configuration</strong></a> •
  <a href="#-contributing"><strong>Contributing</strong></a> •
  <a href="#-contributor-rewards"><strong>Contributor Rewards</strong></a> •
  <a href="#-license"><strong>License</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.3-blue?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green?logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/pnpm-%3E%3D8.10.0-orange?logo=pnpm&logoColor=white" alt="pnpm">
  <img src="https://img.shields.io/badge/VS%20Code-%5E1.85.0-purple?logo=visual-studio-code&logoColor=white" alt="VS Code">
  <img src="https://img.shields.io/badge/Turbo-1.11-red?logo=turborepo&logoColor=white" alt="Turbo">
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="License">
</p>

<p align="center">
  <img src="LOGO/NexiPi%203D%20Logo%20on%20Black.png" alt="NexiPi 3D Logo" width="600">
</p>

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🤖 **AI-Powered Coding** | Intelligent code generation, refactoring, and analysis using LLMs |
| 🔌 **Extensible Architecture** | Plugin-based design with clean separation of concerns |
| 📦 **Monorepo Structure** | Managed with Turborepo for fast, incremental builds |
| 🎯 **TypeScript-First** | Strict typing across all packages with Zod validation |
| 🧪 **Comprehensive Testing** | Unit, integration, and E2E tests with Vitest |
| 🔧 **VS Code Native** | Deep integration with VS Code APIs and UI |
| 💾 **Persistence Layer** | SQLite-backed conversation and state management |
| 🎨 **React UI** | Modern, accessible webview-based interface |
| ⚡ **Streaming Support** | Real-time token streaming for responsive UX |
| 🛡️ **Secure by Default** | Credential management and input sanitization |

---

## 🏗 Architecture

```
nexipi/
├── 📱 apps/
│   └── vscode-extension/          # VS Code extension host & entry point
├── 📦 packages/
│   ├── core/                      # Core agent logic, LLM orchestration, tool execution
│   ├── shared/                    # Shared types, utilities, constants, streaming helpers
│   ├── models/                    # Chat models, credentials, model registry, streaming
│   ├── persistence/               # SQLite persistence, repositories, conversation storage
│   ├── workspace/                 # Workspace discovery, project analysis, monorepo detection
│   └── ui/                        # React-based webview UI components & hooks
└── ⚙️  Root config (turbo, eslint, prettier, typescript)
```

### Dependency Graph

```mermaid
graph TD
    A[vscode-extension] --> B[@nexipi/core]
    A --> C[@nexipi/models]
    A --> D[@nexipi/persistence]
    A --> E[@nexipi/shared]
    A --> F[@nexipi/ui]
    A --> G[@nexipi/workspace]
    
    B --> E
    C --> B
    C --> D
    C --> E
    D --> E
    G --> B
    G --> E
    F --> E
```

---

## 🚀 Quick Start

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| **Node.js** | ≥ 18.0.0 | [nodejs.org](https://nodejs.org/) |
| **pnpm** | ≥ 8.10.0 | `npm install -g pnpm` |
| **Git** | Latest | [git-scm.com](https://git-scm.com/) |
| **VS Code** | ≥ 1.85.0 | [code.visualstudio.com](https://code.visualstudio.com/) |

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/nexipi.git
cd nexipi

# Install all dependencies
pnpm install

# Install git hooks (husky)
pnpm prepare

# Build all packages
pnpm build

# Launch VS Code with the extension
code .
# Press F5 to start debugging the extension
```

---

## 📦 Packages

### Core Packages

| Package | Version | Description | Key Features |
|---------|---------|-------------|--------------|
| **[@nexipi/core](./packages/core)** | `0.0.1` | Core agent runtime, LLM orchestration, tool execution engine | Task queue, concurrency control, event system, sanitization |
| **[@nexipi/shared](./packages/shared)** | `0.0.1` | Shared TypeScript types, utilities, constants, streaming helpers | Zod schemas, type guards, streaming utilities, chat types |
| **[@nexipi/models](./packages/models)** | `0.0.1` | Model registry, chat completions, credentials management | Multi-provider support, streaming, persistence integration |
| **[@nexipi/persistence](./packages/persistence)** | `0.0.1` | SQLite-backed persistence layer with repository pattern | Conversations, messages, integrity checks, migrations |
| **[@nexipi/workspace](./packages/workspace)** | `0.0.1` | Workspace discovery, project analysis, monorepo detection | Manifest registry, project analyzer, workspace provider |
| **[@nexipi/ui](./packages/ui)** | `0.0.1` | React-based webview UI components and hooks | Composer, chat area, status indicator, welcome screen |

### Applications

| App | Version | Description |
|-----|---------|-------------|
| **[vscode-extension](./apps/vscode-extension)** | `0.0.1` | VS Code extension entry point, commands, views, configuration |

---

## 🛠 Development

### Available Scripts

```bash
# ─────────────────────────────────────────────
# Development
# ─────────────────────────────────────────────
pnpm dev              # Run all packages in watch mode
pnpm dev --filter=@nexipi/core    # Watch single package

# ─────────────────────────────────────────────
# Building
# ─────────────────────────────────────────────
pnpm build            # Build all packages (respects dependencies)
pnpm build --filter=@nexipi/core  # Build single package

# ─────────────────────────────────────────────
# Testing
# ─────────────────────────────────────────────
pnpm test             # Run all tests
pnpm test --filter=@nexipi/core   # Test single package
pnpm test:watch       # Watch mode for tests

# ─────────────────────────────────────────────
# Code Quality
# ─────────────────────────────────────────────
pnpm typecheck        # TypeScript type checking across all packages
pnpm lint             # ESLint across all packages
pnpm format           # Prettier formatting
pnpm format:check     # Check formatting without writing

# ─────────────────────────────────────────────
# VS Code Extension
# ─────────────────────────────────────────────
cd apps/vscode-extension
pnpm run package      # Create .vsix package
pnpm run vscode:prepublish  # Pre-publish build
```

### Turbo Commands

```bash
# Run task across all packages with dependency graph
turbo run build
turbo run test
turbo run lint

# Run only changed packages since main
turbo run build --filter=...[origin/main]

# Show dependency graph
turbo run build --dry-run
```

---

## ⚙️ Configuration

### VS Code Settings

Configure NexiPi through VS Code settings (`settings.json`):

```json
{
  "nexipi.enabled": true,
  "nexipi.logLevel": "info"
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `nexipi.enabled` | `boolean` | `true` | Enable/disable the extension |
| `nexipi.logLevel` | `"debug" \| "info" \| "warn" \| "error"` | `"info"` | Output channel verbosity |

### Environment Variables

Create a `.env` file at the root:

```env
# LLM Provider API Keys (choose one or more)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_AI_API_KEY=...

# Optional: Custom model endpoints
OPENAI_BASE_URL=https://api.openai.com/v1
ANTHROPIC_BASE_URL=https://api.anthropic.com
```

### Extension Commands

| Command | Title | Keybinding |
|---------|-------|------------|
| `nexipi.start` | NexiPi: Start | — |
| `nexipi.showOutput` | NexiPi: Show Output | — |
| `nexipi.showInformation` | NexiPi: Show Information | — |
| `nexipi.focusSidebar` | NexiPi: Focus Sidebar | — |

Access via Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).

---

## 🧪 Testing Strategy

```
├── Unit Tests           # Vitest, per-package (packages/*/src/**/*.test.ts)
├── Integration Tests    # Cross-package (packages/*/src/**/*.integration.test.ts)
├── E2E Tests            # VS Code extension (apps/vscode-extension/src/**/*.test.ts)
└── Type Tests           # TypeScript compiler API (tsc --noEmit)
```

Run specific test suites:

```bash
# Core engine tests
pnpm --filter=@nexipi/core test

# Persistence integration tests
pnpm --filter=@nexipi/persistence test -- --reporter=verbose

# UI component tests
pnpm --filter=@nexipi/ui test

# Extension E2E tests
pnpm --filter=nexipi test
```

---

## 📁 Project Structure Details

<details>
<summary><strong>Click to expand full directory tree</strong></summary>

```
nexipi/
├── .github/                    # GitHub workflows, issue templates
├── .vscode/                    # VS Code workspace settings
├── apps/
│   └── vscode-extension/
│       ├── src/
│       │   ├── extension.ts    # Extension entry point
│       │   ├── commands/       # Command implementations
│       │   ├── views/          # Webview providers
│       │   └── test-setup.ts   # Test configuration
│       ├── resources/
│       │   └── nexipi-icon.svg # Extension icon
│       ├── scripts/
│       │   └── copy-wasm.mjs   # WASM binary copy script
│       └── package.json
├── packages/
│   ├── core/
│   │   ├── src/
│   │   │   ├── engine.ts       # Agent execution engine
│   │   │   ├── tasks.ts        # Task queue & concurrency
│   │   │   ├── events.ts       # Event emitter system
│   │   │   ├── config.ts       # Configuration management
│   │   │   ├── sanitize.ts     # Input sanitization
│   │   │   ├── logger.ts       # Structured logging
│   │   │   ├── errors.ts       # Error classes
│   │   │   └── version.ts      # Version info
│   │   └── package.json
│   ├── shared/
│   │   ├── src/
│   │   │   ├── types.ts        # Core type definitions
│   │   │   ├── constants.ts    # Application constants
│   │   │   ├── streaming.ts    # Streaming utilities
│   │   │   └── chat.ts         # Chat-related types
│   │   └── package.json
│   ├── models/
│   │   ├── src/
│   │   │   ├── registry.ts     # Model provider registry
│   │   │   ├── chat.ts         # Chat completion logic
│   │   │   ├── credentials.ts  # Credential management
│   │   │   ├── persistence-adapter.ts
│   │   │   ├── streaming.ts    # Streaming implementation
│   │   │   └── errors.ts       # Model-specific errors
│   │   └── package.json
│   ├── persistence/
│   │   ├── src/
│   │   │   ├── PersistenceService.ts
│   │   │   ├── repositories.ts # Repository implementations
│   │   │   ├── port.ts         # Port interface
│   │   │   └── PersistenceServiceWrapper.ts
│   │   └── package.json
│   ├── workspace/
│   │   ├── src/
│   │   │   ├── discovery/
│   │   │   │   ├── workspace-discovery.ts
│   │   │   │   └── workspace-provider.ts
│   │   │   ├── analysis/
│   │   │   │   ├── project-analyzer.ts
│   │   │   │   ├── monorepo-detector.ts
│   │   │   │   └── manifest-registry.ts
│   │   │   ├── config.ts
│   │   │   └── events/
│   │   │       └── workspace-events.ts
│   │   └── package.json
│   └── ui/
│       ├── src/
│       │   ├── components/
│       │   │   ├── App.tsx
│       │   │   ├── Header.tsx
│       │   │   ├── Composer.tsx
│       │   │   ├── ChatArea.tsx
│       │   │   ├── WelcomeScreen.tsx
│       │   │   └── StatusIndicator.tsx
│       │   ├── hooks/
│       │   │   └── useChat.ts
│       │   ├── styles/
│       │   │   └── main.css
│       │   └── main.tsx
│       ├── index.html
│       └── package.json
├── turbo.json                  # Turborepo pipeline config
├── pnpm-workspace.yaml         # PNPM workspace config
├── tsconfig.json               # Root TypeScript config
├── .eslintrc.js                # ESLint config
├── .prettierrc                 # Prettier config
├── CONTRIBUTING.md             # Contribution guidelines
└── README.md                   # This file
```
</details>

---

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Quick Contribution Checklist

- [ ] Fork the repository
- [ ] Create a feature branch: `git checkout -b feature/amazing-feature`
- [ ] Install dependencies: `pnpm install`
- [ ] Make your changes with tests
- [ ] Run quality checks: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`
- [ ] Format code: `pnpm format`
- [ ] Commit with conventional commits: `git commit -m "feat: add amazing feature"`
- [ ] Push and open a Pull Request

### Branch Naming Convention

| Prefix | Purpose |
|--------|---------|
| `feature/` | New features |
| `fix/` | Bug fixes |
| `docs/` | Documentation updates |
| `refactor/` | Code refactoring |
| `test/` | Test additions |
| `chore/` | Maintenance tasks |

---

## 💰 Contributor Rewards

We believe in recognizing and rewarding valuable contributions. **When NexiPi achieves commercial success**, contributors will be compensated based on their impact:

| Contribution Type | Reward Criteria |
|-------------------|-----------------|
| 🎯 **Core Features** | Major feature implementation, architecture decisions |
| 🐛 **Bug Fixes** | Critical fixes, security patches, performance improvements |
| 📚 **Documentation** | Comprehensive guides, API docs, tutorials |
| 🧪 **Testing** | Test coverage improvements, E2E test suites |
| 🎨 **UI/UX** | Design improvements, accessibility, user experience |
| 🔧 **Infrastructure** | CI/CD, build optimization, developer tooling |
| 🤝 **Community** | Code reviews, issue triage, mentoring, advocacy |

### How It Works

1. **Track Contributions** — All PRs, issues, reviews, and discussions are logged
2. **Impact Scoring** — Contributions weighted by complexity, impact, and maintenance burden
3. **Revenue Sharing** — Upon commercialization (SaaS, enterprise licenses, marketplace), a contributor pool is distributed proportionally
4. **Transparency** — Quarterly reports on project health, revenue, and distribution

> **Note**: This is a statement of intent. Specific terms, percentages, and legal structure will be formalized via a Contributor License Agreement (CLA) and token/equity framework before monetization. Early contributors will be prioritized.

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

- Built with [Turborepo](https://turbo.build/) for monorepo management
- Powered by [TypeScript](https://www.typescriptlang.org/) and [Zod](https://zod.dev/)
- UI built with [React](https://react.dev/) and [Vite](https://vitejs.dev/)
- Testing with [Vitest](https://vitest.dev/) and [Testing Library](https://testing-library.com/)
- VS Code Extension API by [Microsoft](https://code.visualstudio.com/api)

---

<p align="center">
  Made with ❤️ by the NexiPi Team
</p>

<p align="center">
  <a href="https://github.com/your-org/nexipi/stargazers">⭐ Star us on GitHub</a> •
  <a href="https://github.com/your-org/nexipi/issues">🐛 Report Bug</a> •
  <a href="https://github.com/your-org/nexipi/discussions">💬 Discussions</a>
</p>