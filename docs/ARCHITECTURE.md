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

### 2.4 Observability Services (`services/observability`)

- Metrics ingestion/adapters
- Log collection adapters
- Alerting and notification pipeline integration

### 2.5 Security Services (`services/security`)

- Access policy engine integration
- Secret and credential handling interfaces
- Audit event emission and reporting

## 3. Deployment profiles

### 3.1 Simple profile

- Single control-plane instance
- Direct management of one or a few DB servers
- Minimal external dependencies

### 3.2 Standard profile

- Highly available control-plane components
- Managed DB groups with role-aware operations
- External metrics/logging stack

### 3.3 Cluster/enterprise profile

- Multi-region or multi-AZ operation
- Policy-driven automation and compliance layers
- Strong audit and separation-of-duties support

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
6. Expand connectors and observability/security integrations
