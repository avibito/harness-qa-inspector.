/*
 * Harness QA Team — shared-folder storage (no server, no Claude).
 * Uses the browser File System Access API (Chrome / Edge on desktop).
 * Layout inside the chosen folder:
 *   data/<collection>/<id>.json    one file per record (netlists, runs, runData, cases, programs, requirements)
 *   data/team.json                 team members and roles
 *   data/drawings/<netlistId>.<ext> source drawing attached to a netlist
 * Writes go through createWritable(), which commits on close (no half-written files).
 */
(function (root) {
  'use strict';
  const IDB = 'hqa-folder', KEY = 'dir';
  const enc = id => String(id).replace(/[^\w\-.]/g, c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  const dec = n => n.replace(/%([0-9a-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  function deepMerge(a, b) { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v; return o; }

  function idb() { return new Promise((res, rej) => { const r = indexedDB.open(IDB, 1); r.onupgradeneeded = () => r.result.createObjectStore('h'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async function idbDo(mode, fn) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('h', mode); const q = fn(t.objectStore('h')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); }
  const saveHandle = h => idbDo('readwrite', s => s.put(h, KEY)).catch(() => null);
  const loadHandle = () => idbDo('readonly', s => s.get(KEY)).catch(() => null);

  class FolderStore {
    constructor(dir) { this.dir = dir; this.cache = new Map(); this.timers = []; this.subs = new Map(); }
    get name() { return this.dir.name; }
    async sub(col) { const d = await this.dir.getDirectoryHandle('data', { create: true }); return col ? d.getDirectoryHandle(col, { create: true }) : d; }
    async readFile(dirH, name) { try { const fh = await dirH.getFileHandle(name); return JSON.parse(await (await fh.getFile()).text()); } catch (e) { if (e.name === 'NotFoundError') return null; throw e; } }
    async writeFile(dirH, name, data) { const fh = await dirH.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(typeof data === 'string' || data instanceof Blob ? data : JSON.stringify(data, null, 1)); await w.close(); }
    async get(col, id) { return this.readFile(await this.sub(col), enc(id) + '.json'); }
    async put(col, id, data) { await this.writeFile(await this.sub(col), enc(id) + '.json', data); this.poke(col); }
    async patch(col, id, data) {
      const cur = await this.get(col, id);
      if (!cur) throw { code: 'invalid_argument', message: 'record not found' };
      await this.put(col, id, deepMerge(cur, data));
    }
    // list a collection; re-reads only files whose size/time changed
    async list(col) {
      const d = await this.sub(col), out = [];
      for await (const [name, h] of d.entries()) {
        if (h.kind !== 'file' || !name.endsWith('.json')) continue;
        const f = await h.getFile(), ck = col + '/' + name, sig = f.lastModified + ':' + f.size;
        let c = this.cache.get(ck);
        if (!c || c.sig !== sig) { try { c = { sig, data: JSON.parse(await f.text()) }; this.cache.set(ck, c); } catch (e) { continue; } }
        out.push({ id: dec(name.slice(0, -5)), ...c.data });
      }
      return out;
    }
    watch(col, cb, ms) {
      let last = '';
      const tick = async () => {
        try { const rows = await this.list(col); const sig = JSON.stringify(rows.map(r => [r.id, r.updatedAt || r.createdAt || ''])); if (sig !== last) { last = sig; cb(rows); } }
        catch (e) { cb(null, e); }
      };
      this.subs.set(col, tick); tick();
      this.timers.push(setInterval(tick, ms || 12000));
    }
    poke(col) { const t = this.subs.get(col); if (t) setTimeout(t, 30); }
    async team() { return (await this.readFile(await this.sub(''), 'team.json')) || { members: [] }; }
    async saveTeam(t) { await this.writeFile(await this.sub(''), 'team.json', t); }
    async saveDrawing(id, file) { const d = await this.sub('drawings'); const ext = (file.name.match(/\.\w+$/) || ['.bin'])[0].toLowerCase(); await this.writeFile(d, enc(id) + ext, file); return enc(id) + ext; }
    async readDrawing(name) { try { const d = await this.sub('drawings'); return await (await d.getFileHandle(name)).getFile(); } catch (e) { return null; } }
  }

  // Connect: reuse a remembered folder if permission is still granted; otherwise needs a click.
  async function restore() {
    const h = await loadHandle();
    if (!h) return { state: 'none' };
    try { const p = await h.queryPermission({ mode: 'readwrite' }); return { state: p === 'granted' ? 'ok' : 'prompt', handle: h }; }
    catch (e) { return { state: 'none' }; }
  }
  async function reconnect(h) { const p = await h.requestPermission({ mode: 'readwrite' }); if (p !== 'granted') throw new Error('לא ניתנה הרשאה לתיקייה'); return new FolderStore(h); }
  async function pick() { const h = await root.showDirectoryPicker({ id: 'harness-qa', mode: 'readwrite' }); await saveHandle(h); return new FolderStore(h); }
  async function opfs() { return new FolderStore(await navigator.storage.getDirectory()); } // testing only
  const supported = () => typeof root.showDirectoryPicker === 'function';

  root.HQAFS = { FolderStore, restore, reconnect, pick, opfs, supported, deepMerge };
})(typeof globalThis !== 'undefined' ? globalThis : this);
