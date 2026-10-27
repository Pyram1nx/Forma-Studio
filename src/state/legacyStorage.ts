// Browser storage used to be keyed `shaperstudio:*`. Move those entries to `formastudio:*`
// so autosaved designs and settings survive the rename. Runs once per page load, before
// the store and the file code read their keys (see main.tsx, which imports this first).
const OLD_PREFIX = 'shaperstudio:'
const NEW_PREFIX = 'formastudio:'

export function migrateLegacyStorage() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const oldKey = localStorage.key(i)
      if (!oldKey?.startsWith(OLD_PREFIX)) continue
      const newKey = NEW_PREFIX + oldKey.slice(OLD_PREFIX.length)
      const value = localStorage.getItem(oldKey)
      if (value !== null && localStorage.getItem(newKey) === null) localStorage.setItem(newKey, value)
      localStorage.removeItem(oldKey)
    }
  } catch {
    // Storage blocked or full: the app runs without the old data.
  }
}

migrateLegacyStorage()
