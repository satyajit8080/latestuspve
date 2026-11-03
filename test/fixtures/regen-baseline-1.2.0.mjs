// Deliberate regeneration of the frozen opt-1.2.0 baseline. Run only when scoring was changed on purpose.
import fs from 'node:fs';
import path from 'node:path';
import { buildOptionsSignal } from '../../engine/options-engine.js';
import { FIXTURES_V2, captureBaselineV2 } from './engine-fixtures.mjs';
const out = {};
for (const fx of FIXTURES_V2) out[fx.name] = captureBaselineV2(buildOptionsSignal(fx.chain, fx.ctx, {}));
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'baseline-signals-1.2.0.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote baseline-signals-1.2.0.json');
