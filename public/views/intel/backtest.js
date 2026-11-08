import { h, mount } from '../../ui/dom.js';
import { emptyState } from '../../ui/parts.js';
export function renderBacktest(host) { mount(host, emptyState('Strategy Backtesting', 'Loading…')); return { destroy() {} }; }
