# Engine connectors

Shared plugin contract for database engines.

- `EngineConnector` exposes `init`, `shutdown`, `health`, `discover`, and `validateConfig`.
- `ConnectorRegistry` owns the lifecycle. `createDefaultRegistry()` registers PostgreSQL plus MySQL and MariaDB placeholders.
- PostgreSQL, MySQL, and MariaDB connectors probe health, list databases, collect connections, size, and replication lag, build a backup catalog, and run hardening checks.
- Password rotation and PostgreSQL promotion issue SQL only when the control plane asks for it.
- Pass a session opener into `PostgresConnector` when testing without a live server.

The control plane calls this package. It does not shell out to the database process.
