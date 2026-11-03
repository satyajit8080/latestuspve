// Hash routes: #/scan?min=70  #/t/NVDA  #/journal?tab=blotter  #/shadow  #/system
export function parseHash(hash) {
  const raw = (hash || '').replace(/^#/, '') || '/scan';
  const [path, qs = ''] = raw.split('?');
  const seg = path.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(qs));
  const view = seg[0] || 'scan';
  return { view, param: seg[1] ? decodeURIComponent(seg[1]) : null, query };
}
export const buildHash = (view, param, query) => {
  const q = new URLSearchParams(Object.entries(query || {}).filter(([, v]) => v !== '' && v != null)).toString();
  return `#/${view}${param ? '/' + encodeURIComponent(param) : ''}${q ? '?' + q : ''}`;
};
export const navigate = (hash) => { if (location.hash !== hash) location.hash = hash; };
export const replaceQuery = (view, param, query) => history.replaceState(null, '', buildHash(view, param, query));
export function onRoute(cb) { const f = () => cb(parseHash(location.hash)); addEventListener('hashchange', f); f(); return () => removeEventListener('hashchange', f); }
