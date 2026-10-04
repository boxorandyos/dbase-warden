# Services

Shared domain modules used by the control plane.

- `engines/` implements the connector interface for PostgreSQL, MySQL, and MariaDB: health, discovery, metrics, backup catalogs, hardening checks, promotion, and password rotation.

Metrics, alert evaluation, event ingest, policies, secret versions, and audit export live in the control plane (`apps/control-plane/src/catalog.ts` and `operations.ts`). They are not separate processes.
