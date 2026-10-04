import type { EngineConnector, EngineKind } from './types';
import { ConnectorError } from './types';
import { PostgresConnector } from './postgres/connector';
import { PlaceholderConnector } from './placeholder';

export interface ConnectorDescription {
  kind: EngineKind;
  implemented: boolean;
}

export class ConnectorRegistry {
  private readonly connectors = new Map<EngineKind, EngineConnector>();
  private initialized = false;

  register(connector: EngineConnector): void {
    this.connectors.set(connector.kind, connector);
  }

  get(kind: EngineKind): EngineConnector {
    const connector = this.connectors.get(kind);
    if (!connector) {
      throw new ConnectorError(`No connector registered for ${kind}`);
    }
    return connector;
  }

  has(kind: string): kind is EngineKind {
    return this.connectors.has(kind as EngineKind);
  }

  describe(): ConnectorDescription[] {
    return [...this.connectors.values()].map((connector) => ({
      kind: connector.kind,
      implemented: connector.implemented,
    }));
  }

  async initAll(): Promise<void> {
    for (const connector of this.connectors.values()) {
      await connector.init();
    }
    this.initialized = true;
  }

  async shutdownAll(): Promise<void> {
    for (const connector of this.connectors.values()) {
      await connector.shutdown();
    }
    this.initialized = false;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }
}

export function createDefaultRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(new PostgresConnector());
  registry.register(new PlaceholderConnector('mysql'));
  registry.register(new PlaceholderConnector('mariadb'));
  return registry;
}
