/**
 * Tiny observable store shared by the shell and every view.
 *
 * Values are replaced, never mutated in place: callers pass a partial patch and
 * the store shallow-merges it. A patch that changes nothing does not notify, so
 * views can safely call setState() while painting.
 *
 *   const store = createStore({ report: null });
 *   const stop = store.subscribe(state => console.log(state.report));
 *   store.set({ report });
 *   store.set(previous => ({ ...previous, loading: true }));
 *   stop();
 */

export function createStore(initial = {}) {
  let state = { ...initial };
  const listeners = new Set();

  function get() {
    return state;
  }

  function set(patch) {
    const next = typeof patch === 'function' ? patch(state) : patch;
    if (!next || typeof next !== 'object') return state;
    let changed = false;
    const merged = { ...state };
    for (const [key, value] of Object.entries(next)) {
      if (Object.is(merged[key], value)) continue;
      merged[key] = value;
      changed = true;
    }
    if (!changed) return state;
    state = merged;
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch (error) {
        // One broken subscriber must not stop the rest of the UI from updating.
        console.error('BlastRadius state subscriber failed', error);
      }
    }
    return state;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function update(producer) {
    return set(producer(state));
  }

  return { get, set, subscribe, update };
}
