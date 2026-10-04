export type {
  ConfigValidation,
  DiscoverReport,
  EngineConnector,
  EngineKind,
  EngineTarget,
  HealthReport,
  InstanceRole,
  QuerySession,
} from './types';
export { ConnectorError } from './types';
export { ConnectorRegistry, createDefaultRegistry } from './registry';
export type { ConnectorDescription } from './registry';
export { PostgresConnector, openPgSession } from './postgres/connector';
export { PlaceholderConnector } from './placeholder';
