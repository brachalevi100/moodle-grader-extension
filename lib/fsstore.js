// Persists the chosen base folder handle (File System Access API) in IndexedDB.
(function (root) {
  'use strict';
  const DB = 'moodle-grader', STORE = 'handles';

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r && r.result);
      t.onerror = () => reject(t.error);
    });
  }

  const FsStore = {
    get: (key) => tx('readonly', (s) => s.get(key)),
    set: (key, value) => tx('readwrite', (s) => s.put(value, key)),
    del: (key) => tx('readwrite', (s) => s.delete(key)),

    // Must be called from a user gesture if permission is not yet granted.
    async ensurePermission(handle, request = true) {
      const opts = { mode: 'readwrite' };
      if ((await handle.queryPermission(opts)) === 'granted') return true;
      if (!request) return false;
      return (await handle.requestPermission(opts)) === 'granted';
    },

    async writeFile(dir, name, data) {
      let existed = true;
      try { await dir.getFileHandle(name); } catch (_) { existed = false; }
      const fh = await dir.getFileHandle(name, { create: true });
      await FsStore.writeHandle(fh, data);
      return { existed };
    },

    // Overwrites an existing file through its own handle. On failure (e.g. the file is open in Excel)
    // the temporary swap file is discarded and the original stays untouched.
    async writeHandle(fh, data) {
      const w = await fh.createWritable();
      try {
        await w.write(data);
        await w.close();
      } catch (e) {
        try { await w.abort(); } catch (_) { /* already closed */ }
        throw e;
      }
    },

    // Reads every file under a directory (recursively) as [{ name: 'sub/file.py', data: Uint8Array }]
    async readAll(dir, prefix = '') {
      const out = [];
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'file') {
          const f = await h.getFile();
          out.push({ name: prefix + name, data: new Uint8Array(await f.arrayBuffer()) });
        } else {
          out.push(...(await FsStore.readAll(h, prefix + name + '/')));
        }
      }
      return out;
    },
  };
  root.FsStore = FsStore;
})(globalThis);
