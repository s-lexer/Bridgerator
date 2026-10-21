// Preload for the Desktop Commander child: registers dc-config-hooks.mjs (see there).
import { register } from 'node:module';

if (!process.env.BRIDGERATOR_DC_CONFIG_DIR) throw new Error('bridgerator: BRIDGERATOR_DC_CONFIG_DIR not set');
// The folder goes to the patched engine modules through a global, and the variable is removed from
// the environment: the engine's terminal (start_process) inherits process.env and must not learn
// where Bridgerator keeps its settings.
globalThis.__BRG_DC_DIR = process.env.BRIDGERATOR_DC_CONFIG_DIR;
delete process.env.BRIDGERATOR_DC_CONFIG_DIR;
register('./dc-config-hooks.mjs', import.meta.url);
