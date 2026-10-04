# Dbase Warden Architecture (Initial)

## 1. Scope

Dbase Warden manages database infrastructure and adjacent supporting services across single-node and clustered deployments.

Core domains:

- Inventory and topology
- Database lifecycle operations
- Observability and alerting
- Security and compliance controls
- Job orchestration and automation

## 2. High-level components

### 2.1 Web Console (`apps/web-console`)

- Operator-facing GUI
- Layout and interaction patterns aligned with Nginx Warden and Mail Warden
- Dbase-specific color theme to visually differentiate product line

### 2.2 Control Plane API (`apps/control-plane`)

- Source of truth for resources and policies
- AuthN/AuthZ checks for every action
- Job scheduling and workflow orchestration hooks

### 2.3 Engine Connectors (`services/engines`)

- MySQL connector
- MariaDB connector
- PostgreSQL connector
- Common connector interface for consistent actions

### 2.4 Observability

Implemented inside the control plane, not as a separate service:

- Metric samples collected by a connector and stored per engine
- An event stream that jobs and operators can append to
- Alert rules for availability, connections, replication lag, and backup age, with enable and disable

There is no external metrics or log shipping adapter in this build.

### 2.5 Security

Implemented inside the control plane:

- JWT roles (`admin`, `moderator`, `viewer`) and service accounts
- `local://` credential references, secret versions, and optional `ALTER ROLE` / `ALTER USER` rotation
- Hardening checks, `require_ssl` and `limit_superusers` policies, and CSV or JSON audit export

## 3. Deployment profiles

### 3.1 Simple profile (shipped)

- One control-plane process, SQLite, and the console static files
- `deploy/Dockerfile` and `deploy/docker-compose.yml`
- Direct management of registered engines

### 3.2 Standard profile (target)

- Highly available control-plane components
- An external metrics and logging stack

No compose file or chart ships for this profile.

### 3.3 Cluster/enterprise profile (target)

- Multi-region or multi-AZ operation
- Separation of duties beyond the three roles

No manifests ship for this profile. Cluster topology in the product is the database cluster record (primary, replica, witness), not a multi-region control plane.

## 4. Initial data model concepts

- **Server**: host or node metadata/capabilities
- **DatabaseEngineInstance**: running engine instance with version/config
- **Cluster**: logical grouping with topology/roles
- **CredentialRef**: indirection to secret provider
- **Policy**: security, backup, and operational rules
- **Job**: auditable asynchronous operation
- **Event/AuditLog**: immutable action and system event records

## 5. First implementation sequence

1. Establish control-plane service skeleton and API conventions
2. Build shared connector interface and one reference engine connector (PostgreSQL)
3. Implement inventory + health checks
4. Add role-based access enforcement
5. Add GUI shell and first management views
6. PostgreSQL, MySQL, and MariaDB connectors, plus observability and security inside the control plane
