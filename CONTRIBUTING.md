# Contributing to NexiPi

Thank you for contributing to NexiPi! Please follow these guidelines to ensure a smooth collaboration process.

## Development Setup

1. Fork and clone the repository
2. Install dependencies: `pnpm install`
3. Install git hooks: `pnpm prepare`
4. Create a feature branch: `git checkout -b feature/your-feature-name`

## Code Style

- **TypeScript**: Strict mode enabled. All new code must pass `pnpm typecheck`
- **Formatting**: Prettier configuration in `.prettierrc`. Run `pnpm format` before committing
- **Linting**: ESLint with TypeScript rules. Run `pnpm lint` before committing
- **Commits**: Conventional Commits format (e.g., `feat:`, `fix:`, `docs:`, `refactor:`)

## Pull Request Process

1. Ensure all checks pass: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`
2. Update documentation if needed
3. Add tests for new functionality
4. Keep PRs focused and atomic
5. Request review from maintainers

## Branch Naming

- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation updates
- `refactor/` - Code refactoring
- `test/` - Test additions
- `chore/` - Maintenance tasks

## Testing

- Write unit tests for new functions and classes
- Integration tests for cross-package functionality
- Run `pnpm test` before submitting PR

## TypeScript Guidelines

- Use strict TypeScript configuration
- Prefer `type` over `interface` for object types
- Use explicit return types for public APIs
- Avoid `any` - use `unknown` or proper generics
- Enable all strict flags in `tsconfig.json`

## Monorepo Conventions

- Internal packages use `@nexipi/*` namespace
- Shared code goes in `packages/shared`
- Core business logic in `packages/core`
- Editor-specific code in `apps/*`
- Use workspace protocol (`workspace:*`) for internal dependencies

## Reporting Issues

- Use GitHub Issues for bugs and feature requests
- Provide minimal reproduction steps
- Include environment details (OS, Node version, pnpm version)

## Code of Conduct

Be respectful, inclusive, and constructive in all interactions.