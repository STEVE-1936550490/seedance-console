# Repository Guidelines

## Project Scope

Seedance Console is a self-hosted internal tool for creating AI video jobs through a Seedance-compatible API. Reproduce only the workflow of a cloud video console; never copy another product's branding, text, icons, or visual assets. The MVP excludes registration, payments, multi-tenancy, and complex RBAC.

`docs/provider-api.md`, once supplied, is the only source of truth for real Seedance fields. Do not invent model names, parameters, limits, statuses, or usage units. Implement and verify the Mock Provider before adding a real provider.

## Project Structure

Use a pnpm workspace:

- `apps/web`: Next.js UI; never contains provider credentials.
- `apps/api`: Fastify HTTP API, validation, and job creation.
- `apps/worker`: BullMQ consumers and provider polling.
- `services/provider-bridge`: optional private Python SDK sidecar; never exposed publicly.
- `packages/contracts`: shared Zod schemas and API types.
- `packages/db`: Prisma schema and database client.
- `packages/providers`: provider interfaces, Mock Provider, and later Seedance adapter.
- `packages/storage`: local storage abstraction, later MinIO/S3 adapters.
- `docs`: product, architecture, and operational decisions.

Keep modules feature-oriented. Tests may live beside code as `*.test.ts`; cross-service tests belong in `tests/`.

## Development Commands

When bootstrapping, expose these root commands:

- `pnpm dev`: run web, API, and worker in watch mode.
- `pnpm build`: build all workspace packages.
- `pnpm lint`: run configured lint rules.
- `pnpm typecheck`: run TypeScript in strict mode.
- `pnpm test`: run unit and integration tests.
- `docker compose up -d`: start PostgreSQL and Redis locally.

## Coding and Testing Conventions

Use TypeScript strict mode, two-space indentation, and the configured formatter/linter. Use `PascalCase` for types and React components, `camelCase` for functions and variables, and `kebab-case` for directories. Validate HTTP and external-provider data with Zod. Prefer typed errors and dependency injection.

Unit-test provider mapping, validation, and state transitions. Integration-test upload, task creation, polling, and terminal outcomes. Tests must be deterministic and use Mock Provider rather than real network calls.

## Security and Data Rules

All model requests pass through the API/worker. Load secrets only from environment variables; never commit `.env`, expose API keys, or log authorization headers. Sanitize logs and filenames; validate uploads; prevent arbitrary paths. Do not expose PostgreSQL or Redis publicly. Retry only safe or idempotent operations.

## Commits and Pull Requests

Use concise imperative Conventional Commit subjects, for example `feat(worker): add mock polling`. Pull requests must state scope, verification, configuration or schema changes, linked issues, and screenshots for UI changes. Keep changes independently verifiable and update affected documentation.
