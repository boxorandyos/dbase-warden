# Engine connectors

Shared plugin contract for database engines.

- `EngineConnector` exposes `init`, `shutdown`, `health`, `discover`, and `validateConfig`.
- `ConnectorRegistry` owns the lifecycle. `createDefaultRegistry()` registers PostgreSQL plus MySQL and MariaDB placeholders.
- The PostgreSQL connector probes `server_version`, `pg_is_in_recovery()`, session count, and the list of connectable databases.
- Pass a session opener into `PostgresConnector` when testing without a live server.

The control plane calls this package. It does not shell out to the database process.
