# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- `CLAUDE_PEERS_ROLE` environment variable for assigning roles to Claude Code instances
- Role field in broker's peers table and all peer-related API responses
- Auto-announce: workers with a role automatically notify coordinators on startup
- Role display in CLI `status` and `peers` commands
- SQLite migration for existing databases (adds `role` column)
- Role field to `Peer` interface in `shared/types.ts` to support peer role identification
- Role field to `RegisterRequest` interface in `shared/types.ts` for peer registration with role information
- Test suite for type definitions in `tests/types.test.ts`
