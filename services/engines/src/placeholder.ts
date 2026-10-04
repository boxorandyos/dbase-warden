import type {
  ConfigValidation,
  DiscoverReport,
  EngineConnector,
  EngineKind,
  EngineTarget,
  HealthReport,
} from './types';
import { ConnectorError } from './types';
import { validateTarget } from './validate';

/** Registered plugin that participates in lifecycle but cannot probe a live engine yet. */
export class PlaceholderConnector implements EngineConnector {
  readonly implemented = false;

  constructor(readonly kind: EngineKind) {}

  async init(): Promise<void> {}

  async shutdown(): Promise<void> {}

  async health(target: EngineTarget): Promise<HealthReport> {
    const validation = await this.validateConfig(target);
    return {
      ok: false,
      engine: this.kind,
      latencyMs: 0,
      details: { issues: validation.issues },
      error: `${this.kind} connector is registered but not implemented`,
    };
  }

  async discover(): Promise<DiscoverReport> {
    throw new ConnectorError(`${this.kind} connector is registered but not implemented`);
  }

  async validateConfig(target: EngineTarget): Promise<ConfigValidation> {
    return validateTarget(target, this.kind === 'postgresql' ? 5432 : 3306);
  }
}
