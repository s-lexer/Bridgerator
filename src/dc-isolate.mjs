// Preload for the Desktop Commander child: registers dc-config-hooks.mjs (see there).
import { register } from 'node:module';

if (!process.env.BRIDGERATOR_DC_CONFIG_DIR) throw new Error('bridgerator: BRIDGERATOR_DC_CONFIG_DIR not set');
register('./dc-config-hooks.mjs', import.meta.url);
