// Simple in-memory job store
const store = new Map();

module.exports = {
  get: (id) => store.get(id),
  set: (id, data) => store.set(id, data),
  has: (id) => store.has(id),
  delete: (id) => store.delete(id),
  clear: () => store.clear(),
  all: () => Array.from(store.values()),
};
