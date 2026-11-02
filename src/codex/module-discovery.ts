/** Resolve Micro modules even when Chromium no longer lists their resource timings. */
export function buildModuleDiscoveryExpression(requireSlots = true): string {
  return String.raw`(async () => {
    const initial = [...new Set([
      ...[...document.querySelectorAll('link[href], script[src]')].map(element => element.href || element.src),
      ...performance.getEntriesByType('resource').map(entry => entry.name)
    ])].filter(url => url.includes('/assets/') && url.endsWith('.js'));
    if (initial.some(url => url.includes('/assets/codex-micro-slot-signals-'))) return initial;
    const key = Symbol.for('codex-deck-module-discovery-v1');
    if (${!requireSlots} && !globalThis[key]) return initial;
    if (globalThis[key]) return [...new Set([...initial, ...await globalThis[key]])];
    const pending = (async () => {
      const base = new URL(document.baseURI);
      const relevant = url => /\/(?:index(?:\.client)?|app-main|app-runtime|app-initial|app-primary|app-shared|codex-micro[^/]*)-[^/]+\.js$/.test(url);
      const known = new Set(initial);
      const queue = initial.filter(relevant);
      const visited = new Set();
      for (let scanned = 0; queue.length && scanned < 24; scanned++) {
        const url = queue.shift();
        if (visited.has(url)) continue;
        visited.add(url);
        const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
        if (!response.ok) throw new Error('Cannot inspect Codex module dependencies.');
        const source = await response.text();
        if (source.length > 16000000) throw new Error('Codex module exceeds discovery limit.');
        const references = source.matchAll(/["'\x60]((?:\.\/|\/assets\/|assets\/)?[A-Za-z0-9_.-]+\.js)["'\x60]/g);
        for (const match of references) {
          const candidate = new URL(match[1], url);
          if (candidate.protocol !== base.protocol || candidate.host !== base.host || !candidate.pathname.startsWith('/assets/') || !relevant(candidate.href)) continue;
          if (!known.has(candidate.href)) { known.add(candidate.href); queue.push(candidate.href); }
        }
        if ([...known].some(value => value.includes('/assets/codex-micro-slot-signals-'))) return [...known];
      }
      throw new Error('Codex Micro slot module is absent from the renderer dependency graph.');
    })();
    globalThis[key] = pending;
    try { return await pending; } catch (error) { if (globalThis[key] === pending) delete globalThis[key]; throw error; }
  })()`;
}
