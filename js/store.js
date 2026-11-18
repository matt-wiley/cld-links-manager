// Linkshelf data layer. Pure logic, no DOM: runs in the browser and under `node --test`.
//
// Data model
//   state.links        { [uuid]: { id, url, name, note, created, updated } }   unique by normalized url
//   state.collections  [ Collection ]
//   Collection         { id, name, links: [linkId], children: [Heading] }      the root container
//   Heading            { id, title, note?, links: [linkId], children: [Heading], collapsed? }
//
// Collections and headings only hold *references* (link UUIDs). A link can appear in
// any number of places; editing it once updates it everywhere. Inside a container the
// links come first, then the sub-headings, exactly like a markdown document, which is
// what makes the markdown export/import lossless.

export const MAX_DEPTH = 6; // heading levels inside a collection, same as markdown h1..h6
export const SCHEMA_VERSION = 1;
const HISTORY_LIMIT = 100;

export function uuid() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const BARE_HOST = /^(localhost|[\w-]+(\.[\w-]+)*\.[a-z]{2,}|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#]|$)/i;

/** Normalize user input into a canonical URL string, or null if it isn't a usable URL. */
export function normalizeUrl(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s || /\s/.test(s)) return null;
  if (/^(javascript|data|vbscript):/i.test(s)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(mailto|tel):/i.test(s);
  if (!hasScheme) {
    if (!BARE_HOST.test(s)) return null;
    s = (/^(localhost|127\.|\[::1\])/i.test(s) ? 'http://' : 'https://') + s;
  }
  try {
    return new URL(s).href;
  } catch {
    return null;
  }
}

/** A readable default name for a URL, e.g. "github.com/matt/repo". */
export function nameFromUrl(url) {
  try {
    const u = new URL(url);
    if (!u.host) return url;
    const host = u.host.replace(/^www\./, '');
    let path = decodeURIComponent(u.pathname).replace(/\/+$/, '');
    const name = host + path;
    return name.length > 80 ? name.slice(0, 77) + '…' : name;
  } catch {
    return url;
  }
}

export function emptyState() {
  return { version: SCHEMA_VERSION, links: {}, collections: [] };
}

function newHeading(title) {
  return { id: uuid(), title: String(title || 'Untitled').trim() || 'Untitled', links: [], children: [] };
}

// ---------- tree helpers (operate on a plain state object) ----------

/** Every container (collections and headings) with its location. depth 0 = collection. */
export function* walkContainers(state) {
  for (const collection of state.collections) {
    yield* walkNode(collection, collection, null, 0, []);
  }
}
function* walkNode(node, collection, parent, depth, path) {
  yield { node, collection, parent, depth, path };
  const childPath = depth === 0 ? [] : [...path, node];
  for (const child of node.children) yield* walkNode(child, collection, node, depth + 1, childPath);
}

export function findContainer(state, id) {
  for (const entry of walkContainers(state)) if (entry.node.id === id) return entry;
  return null;
}

/** Levels of headings in a subtree, counting the heading itself (leaf = 1). */
export function subtreeHeight(heading) {
  let h = 0;
  for (const c of heading.children) h = Math.max(h, subtreeHeight(c));
  return h + 1;
}

function isDescendant(ancestor, id) {
  for (const c of ancestor.children) if (c.id === id || isDescendant(c, id)) return true;
  return false;
}

/** Where is this link referenced? [{ collection, container, depth, path }] */
export function findRefs(state, linkId) {
  const out = [];
  for (const { node, collection, depth, path } of walkContainers(state)) {
    if (node.links.includes(linkId)) out.push({ collection, container: node, depth, path });
  }
  return out;
}

// ---------- collection slugs (for #links) ----------

export const RESERVED_SLUGS = new Set(['all', 'unfiled', 'add', 'search']);

/** "My App!" -> "my-app". Also used to normalize what people type into a URL. */
export function slugify(text) {
  return (
    String(text || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'collection'
  );
}

/** Map of collection id -> unique slug. Duplicates (and reserved words) get -2, -3, … in sidebar order. */
export function collectionSlugs(state) {
  const used = new Set(RESERVED_SLUGS);
  const out = new Map();
  for (const c of state.collections) {
    const base = slugify(c.name);
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    out.set(c.id, slug);
  }
  return out;
}

/** Find a collection from a URL fragment: its slug (case/punctuation-insensitive) or its id. */
export function findCollectionBySlug(state, fragment) {
  const raw = String(fragment || '').trim();
  if (!raw) return null;
  const byId = state.collections.find((c) => c.id === raw);
  if (byId) return byId;
  const want = slugify(raw);
  for (const [id, slug] of collectionSlugs(state)) if (slug === want) return state.collections.find((c) => c.id === id);
  return null;
}

/** Is any heading below this container expanded? */
export function hasExpandedDescendant(container) {
  return container.children.some((h) => !h.collapsed || hasExpandedDescendant(h));
}

export function countLinks(container) {
  let n = container.links.length;
  for (const c of container.children) n += countLinks(c);
  return n;
}

/** Case-insensitive search over name, url and note. All terms must match. */
export function searchLinks(state, query) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const all = Object.values(state.links);
  if (!terms.length) return [];
  const scored = [];
  for (const l of all) {
    const name = l.name.toLowerCase();
    const hay = `${name}\n${l.url.toLowerCase()}\n${(l.note || '').toLowerCase()}`;
    if (!terms.every((t) => hay.includes(t))) continue;
    let score = 0;
    for (const t of terms) {
      if (name.startsWith(t)) score += 3;
      else if (name.includes(t)) score += 2;
      else score += 1;
    }
    scored.push({ l, score });
  }
  scored.sort((a, b) => b.score - a.score || b.l.updated - a.l.updated);
  return scored.map((s) => s.l);
}

// ---------- markdown ----------

const mdEscape = (s) => String(s).replace(/([\[\]\\])/g, '\\$1');
const mdUnescape = (s) => String(s).replace(/\\([\[\]\\])/g, '$1');
// a plain paragraph line that would otherwise parse as a heading, list item, comment or bare URL
const MD_SPECIAL_LINE = /^(#|[-*+]\s|\d+\.\s|<!--|<?[a-z][a-z0-9+.-]*:\/\/|\\)/i;

function mdLinkTarget(url, angle) {
  return angle || /[\s()<>]/.test(url) ? `<${url}>` : url;
}
function writeLinksMd(state, ids, lines, angle) {
  for (const id of ids) {
    const l = state.links[id];
    if (!l) continue;
    lines.push(`- [${mdEscape(l.name)}](${mdLinkTarget(l.url, angle)})`);
    for (const n of (l.note || '').split('\n')) if (n.trim()) lines.push(`  ${n}`);
  }
  if (ids.length) lines.push('');
}
function writeHeadingMd(state, h, depth, lines, angle) {
  lines.push(`${'#'.repeat(depth)} ${h.title}`, '');
  const note = (h.note || '').split('\n').filter((n) => n.trim());
  for (const n of note) lines.push(MD_SPECIAL_LINE.test(n.trim()) ? `\\${n.trim()}` : n.trim());
  if (note.length) lines.push('');
  writeLinksMd(state, h.links, lines, angle);
  for (const c of h.children) writeHeadingMd(state, c, depth + 1, lines, angle);
}

export function collectionToMarkdown(state, collectionId) {
  const col = state.collections.find((c) => c.id === collectionId);
  if (!col) throw new Error('No such collection');
  const lines = [`<!-- collection: ${col.name.replace(/-->/g, '')} -->`, ''];
  writeLinksMd(state, col.links, lines, true);
  for (const h of col.children) writeHeadingMd(state, h, 1, lines, true);
  return lines.join('\n').replace(/\n+$/, '\n');
}

function findHeading(state, headingId) {
  for (const e of walkContainers(state)) if (e.node.id === headingId && e.depth > 0) return e.node;
  throw new Error('No such heading');
}

/**
 * A heading and everything under it as markdown, for the clipboard. Levels are rebased so
 * the copied heading is "#", and plain (url) targets are used for the widest compatibility.
 */
export function headingToMarkdown(state, headingId) {
  const lines = [];
  writeHeadingMd(state, findHeading(state, headingId), 1, lines, false);
  return lines.join('\n').replace(/\n+$/, '\n');
}

const htmlEscape = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:', 'ftp:', 'file:'];

/** The same section as HTML, so pasting into docs, email or chat keeps real headings and links. */
export function headingToHtml(state, headingId) {
  const out = [];
  const note = (text) => htmlEscape(text).replace(/\n/g, '<br>');
  const write = (h, depth) => {
    const tag = `h${Math.min(depth, 6)}`;
    out.push(`<${tag}>${htmlEscape(h.title)}</${tag}>`);
    if (h.note) out.push(`<p>${note(h.note)}</p>`);
    const items = h.links.map((id) => state.links[id]).filter(Boolean);
    if (items.length) {
      out.push('<ul>');
      for (const l of items) {
        let safe = false;
        try {
          safe = SAFE_PROTOCOLS.includes(new URL(l.url).protocol);
        } catch {}
        const name = htmlEscape(l.name);
        const link = safe ? `<a href="${htmlEscape(l.url)}">${name}</a>` : name;
        out.push(`<li>${link}${l.note ? ` — ${note(l.note)}` : ''}</li>`);
      }
      out.push('</ul>');
    }
    for (const c of h.children) write(c, depth + 1);
  };
  write(findHeading(state, headingId), 1);
  return out.join('\n');
}

/** Parse markdown into { name, root } where root is a collection-shaped tree of {url,name,note} items. */
export function parseMarkdown(text) {
  const root = { title: null, items: [], children: [] };
  let name = null;
  const stack = [root];
  let lastItem = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if ((m = line.match(/^<!--\s*collection:\s*(.*?)\s*-->$/i))) {
      name = m[1];
      continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.+?)\s*#*$/))) {
      const level = m[1].length;
      const parentDepth = Math.min(level - 1, stack.length - 1);
      stack.length = parentDepth + 1;
      const h = { title: m[2], note: '', items: [], children: [] };
      stack[parentDepth].children.push(h);
      stack.push(h);
      lastItem = null;
      continue;
    }
    if ((m = line.match(/^\s*(?:[-*+]|\d+\.)\s+\[((?:\\.|[^\]])*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)\s*(?:[—–:-]\s*(.*))?$/))) {
      lastItem = { name: mdUnescape(m[1]).trim(), url: m[2], note: (m[3] || '').trim() };
      stack[stack.length - 1].items.push(lastItem);
      continue;
    }
    if ((m = line.match(/^\s*(?:(?:[-*+]|\d+\.)\s+)?<?([a-z][a-z0-9+.-]*:\/\/[^\s>]+)>?\s*$/i))) {
      lastItem = { name: '', url: m[1], note: '' };
      stack[stack.length - 1].items.push(lastItem);
      continue;
    }
    if (lastItem && /^\s{2,}\S/.test(line)) {
      const t = line.trim().replace(/^>\s?/, '');
      lastItem.note = lastItem.note ? `${lastItem.note}\n${t}` : t;
      continue;
    }
    if (!line.trim()) continue;
    lastItem = null;
    const top = stack[stack.length - 1];
    if (top !== root && !top.items.length && !top.children.length) {
      const t = line.trim().replace(/^\\/, '');
      top.note = top.note ? `${top.note}\n${t}` : t;
    }
  }
  return { name, root };
}

// ---------- validation / migration ----------

export function sanitizeState(input) {
  if (!input || typeof input !== 'object') throw new Error('Not a Linkshelf backup');
  const out = emptyState();
  const links = input.links && typeof input.links === 'object' ? input.links : {};
  for (const [id, l] of Object.entries(links)) {
    if (!l || typeof l.url !== 'string') continue;
    out.links[id] = {
      id,
      url: l.url,
      name: typeof l.name === 'string' && l.name.trim() ? l.name : nameFromUrl(l.url),
      note: typeof l.note === 'string' ? l.note : '',
      created: Number(l.created) || Date.now(),
      updated: Number(l.updated) || Date.now(),
    };
  }
  const fixNode = (n, depth, isCollection) => {
    const node = {
      id: typeof n.id === 'string' ? n.id : uuid(),
      links: [...new Set((Array.isArray(n.links) ? n.links : []).filter((id) => out.links[id]))],
      children: [],
    };
    if (isCollection) node.name = String(n.name || 'Untitled');
    else {
      node.title = String(n.title || 'Untitled');
      if (typeof n.note === 'string' && n.note.trim()) node.note = n.note.trim();
      if (n.collapsed) node.collapsed = true;
    }
    if (depth < MAX_DEPTH) {
      for (const c of Array.isArray(n.children) ? n.children : []) if (c) node.children.push(fixNode(c, depth + 1, false));
    }
    return node;
  };
  for (const c of Array.isArray(input.collections) ? input.collections : []) if (c) out.collections.push(fixNode(c, 0, true));
  return out;
}

// ---------- the store ----------

export class Store {
  constructor({ storage = null, key = 'linkshelf:data' } = {}) {
    this.storage = storage;
    this.key = key;
    this.listeners = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.state = this.load();
  }

  load() {
    try {
      const raw = this.storage?.getItem(this.key);
      if (raw) return sanitizeState(JSON.parse(raw));
    } catch (e) {
      console.error('Linkshelf: could not read saved data', e);
    }
    return emptyState();
  }

  /** Reload from storage (another tab changed it). */
  reload() {
    this.state = this.load();
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  save() {
    this.storage?.setItem(this.key, JSON.stringify(this.state));
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  /** Run a mutation atomically: rolled back on error, recorded for undo, persisted. */
  mutate(fn) {
    if (this._inTx) return fn(this.state); // nested: part of the outer transaction
    const before = JSON.stringify(this.state);
    let result;
    this._inTx = true;
    try {
      result = fn(this.state);
    } catch (e) {
      this.state = JSON.parse(before);
      throw e;
    } finally {
      this._inTx = false;
    }
    if (JSON.stringify(this.state) === before) return result;
    this.undoStack.push(before);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.save();
    this.emit();
    return result;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(JSON.stringify(this.state));
    this.state = JSON.parse(this.undoStack.pop());
    this.save();
    this.emit();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(JSON.stringify(this.state));
    this.state = JSON.parse(this.redoStack.pop());
    this.save();
    this.emit();
    return true;
  }

  // ----- reads -----

  getLink(id) {
    return this.state.links[id] || null;
  }

  getLinkByUrl(url) {
    const norm = normalizeUrl(url) ?? url;
    return Object.values(this.state.links).find((l) => l.url === norm) || null;
  }

  getCollection(id) {
    return this.state.collections.find((c) => c.id === id) || null;
  }

  container(id) {
    return findContainer(this.state, id);
  }

  refs(linkId) {
    return findRefs(this.state, linkId);
  }

  search(q) {
    return searchLinks(this.state, q);
  }

  orphanIds() {
    const used = new Set();
    for (const { node } of walkContainers(this.state)) for (const id of node.links) used.add(id);
    return Object.keys(this.state.links).filter((id) => !used.has(id));
  }

  // ----- collections -----

  addCollection(name) {
    return this.mutate((s) => {
      const c = { id: uuid(), name: String(name || '').trim() || 'Untitled', links: [], children: [] };
      s.collections.push(c);
      return c.id;
    });
  }

  renameCollection(id, name) {
    name = String(name || '').trim();
    if (!name) return;
    this.mutate((s) => {
      const c = s.collections.find((x) => x.id === id);
      if (c) c.name = name;
    });
  }

  deleteCollection(id) {
    this.mutate((s) => {
      s.collections = s.collections.filter((c) => c.id !== id);
    });
  }

  moveCollection(id, toIndex) {
    this.mutate((s) => {
      const from = s.collections.findIndex((c) => c.id === id);
      if (from < 0) return;
      const [c] = s.collections.splice(from, 1);
      if (from < toIndex) toIndex--;
      s.collections.splice(clamp(toIndex, 0, s.collections.length), 0, c);
    });
  }

  // ----- links (the library) -----

  /**
   * Save a link, deduplicating by URL. If the URL exists, the existing record is
   * returned (and name/note updated if given). Optionally place a reference in a container.
   * Returns { link, created, placed }.
   */
  saveLink({ url, name, note }, { containerId = null, index = null } = {}) {
    const norm = normalizeUrl(url);
    if (!norm) throw new Error(`Not a valid URL: ${url}`);
    return this.mutate((s) => {
      let link = Object.values(s.links).find((l) => l.url === norm);
      let created = false;
      const t = Date.now();
      if (!link) {
        link = { id: uuid(), url: norm, name: '', note: '', created: t, updated: t };
        s.links[link.id] = link;
        created = true;
      }
      if (typeof name === 'string' && name.trim()) link.name = name.trim();
      if (!link.name) link.name = nameFromUrl(norm);
      if (typeof note === 'string' && (note.trim() || !created)) link.note = note.trim();
      if (!created && (name !== undefined || note !== undefined)) link.updated = t;
      let placed = false;
      if (containerId) placed = placeRef(s, link.id, containerId, index);
      return { link: { ...link }, created, placed };
    });
  }

  /** Edit a link. Changing the URL to one that already exists merges the two records. */
  updateLink(id, { url, name, note }) {
    return this.mutate((s) => {
      const link = s.links[id];
      if (!link) throw new Error('No such link');
      let target = link;
      if (url !== undefined) {
        const norm = normalizeUrl(url);
        if (!norm) throw new Error(`Not a valid URL: ${url}`);
        const other = Object.values(s.links).find((l) => l.url === norm && l.id !== id);
        if (other) {
          // merge `link` into `other`: re-point every reference, then drop `link`
          for (const { node } of walkContainers(s)) {
            const i = node.links.indexOf(id);
            if (i < 0) continue;
            if (node.links.includes(other.id)) node.links.splice(i, 1);
            else node.links[i] = other.id;
          }
          delete s.links[id];
          target = other;
        } else link.url = norm;
      }
      if (typeof name === 'string') target.name = name.trim() || nameFromUrl(target.url);
      if (typeof note === 'string') target.note = note.trim();
      target.updated = Date.now();
      return target.id;
    });
  }

  /** Delete a link from the library and every place it is referenced. */
  deleteLink(id) {
    this.mutate((s) => {
      delete s.links[id];
      for (const { node } of walkContainers(s)) node.links = node.links.filter((x) => x !== id);
    });
  }

  /**
   * Move (or copy, or add from the library when fromId is null) a link reference.
   * If the target already contains the link, it is just repositioned there.
   */
  moveLink(linkId, fromId, toId, toIndex = null, { copy = false } = {}) {
    this.mutate((s) => {
      if (!s.links[linkId]) throw new Error('No such link');
      const to = findContainer(s, toId);
      if (!to) throw new Error('No such target');
      if (fromId && !copy) {
        const from = findContainer(s, fromId);
        if (from) {
          const i = from.node.links.indexOf(linkId);
          if (i >= 0) {
            from.node.links.splice(i, 1);
            if (fromId === toId && toIndex != null && i < toIndex) toIndex--;
          }
        }
      }
      placeRef(s, linkId, toId, toIndex);
    });
  }

  removeRef(containerId, linkId) {
    this.mutate((s) => {
      const c = findContainer(s, containerId);
      if (c) c.node.links = c.node.links.filter((x) => x !== linkId);
    });
  }

  // ----- headings -----

  addHeading(parentId, title, index = null) {
    return this.mutate((s) => {
      const parent = findContainer(s, parentId);
      if (!parent) throw new Error('No such container');
      if (parent.depth + 1 > MAX_DEPTH) throw new Error(`Headings can nest at most ${MAX_DEPTH} levels deep`);
      const h = newHeading(title);
      insertAt(parent.node.children, h, index);
      return h.id;
    });
  }

  renameHeading(id, title) {
    title = String(title || '').trim();
    if (!title) return;
    this.mutate((s) => {
      const c = findContainer(s, id);
      if (c && c.depth > 0) c.node.title = title;
    });
  }

  /** Update a heading's title and/or note. An empty note removes it. */
  updateHeading(id, { title, note } = {}) {
    this.mutate((s) => {
      const c = findContainer(s, id);
      if (!c || c.depth === 0) throw new Error('No such heading');
      if (typeof title === 'string' && title.trim()) c.node.title = title.trim();
      if (typeof note === 'string') {
        if (note.trim()) c.node.note = note.trim();
        else delete c.node.note;
      }
    });
  }

  toggleCollapsed(id, value) {
    // collapse state is a view preference: persist it, but keep it out of undo history
    const c = findContainer(this.state, id);
    if (!c || c.depth === 0) return;
    const next = value ?? !c.node.collapsed;
    if (next) c.node.collapsed = true;
    else delete c.node.collapsed;
    this.save();
    this.emit();
  }

  /**
   * Collapse or expand every heading below container `id` in one step.
   * `self` optionally sets the container's own state too (ignored for collections).
   * A view preference like toggleCollapsed: persisted, not part of undo history.
   */
  setCollapsedDeep(id, collapsed, { self } = {}) {
    const c = findContainer(this.state, id);
    if (!c) return;
    const apply = (h, v) => {
      if (v) h.collapsed = true;
      else delete h.collapsed;
    };
    const walk = (n) => {
      for (const ch of n.children) {
        apply(ch, collapsed);
        walk(ch);
      }
    };
    walk(c.node);
    if (self !== undefined && c.depth > 0) apply(c.node, self);
    this.save();
    this.emit();
  }

  /** Delete a heading. keepContents=true lifts its links and sub-headings into the parent. */
  deleteHeading(id, { keepContents = false } = {}) {
    this.mutate((s) => {
      const c = findContainer(s, id);
      if (!c || c.depth === 0) return;
      const siblings = c.parent.children;
      const i = siblings.indexOf(c.node);
      siblings.splice(i, 1);
      if (keepContents) {
        for (const l of c.node.links) if (!c.parent.links.includes(l)) c.parent.links.push(l);
        siblings.splice(i, 0, ...c.node.children);
      }
    });
  }

  /** Can heading `id` be moved under container `toId`? Returns an error string or null. */
  canMoveHeading(id, toId) {
    const h = findContainer(this.state, id);
    const to = findContainer(this.state, toId);
    if (!h || !to || h.depth === 0) return 'Not found';
    if (h.node.id === toId || isDescendant(h.node, toId)) return "Can't move a heading inside itself";
    if (to.depth + subtreeHeight(h.node) > MAX_DEPTH) return `Headings can nest at most ${MAX_DEPTH} levels deep`;
    return null;
  }

  moveHeading(id, toId, toIndex = null) {
    const err = this.canMoveHeading(id, toId);
    if (err) throw new Error(err);
    this.mutate((s) => {
      const h = findContainer(s, id);
      const to = findContainer(s, toId);
      const siblings = h.parent.children;
      const i = siblings.indexOf(h.node);
      siblings.splice(i, 1);
      if (h.parent === to.node && toIndex != null && i < toIndex) toIndex--;
      insertAt(to.node.children, h.node, toIndex);
    });
  }

  // ----- import / export -----

  exportJSON() {
    return JSON.stringify({ app: 'linkshelf', exported: new Date().toISOString(), ...this.state }, null, 2);
  }

  /** mode 'replace' swaps everything; 'merge' adds collections and dedupes links by URL. */
  importJSON(text, { mode = 'merge' } = {}) {
    const incoming = sanitizeState(typeof text === 'string' ? JSON.parse(text) : text);
    this.mutate((s) => {
      if (mode === 'replace') {
        s.links = incoming.links;
        s.collections = incoming.collections;
        return;
      }
      const remap = {};
      for (const l of Object.values(incoming.links)) {
        const norm = normalizeUrl(l.url) ?? l.url;
        let existing = Object.values(s.links).find((x) => x.url === norm);
        if (!existing) {
          existing = { ...l, id: uuid(), url: norm };
          s.links[existing.id] = existing;
        } else if (!existing.note && l.note) existing.note = l.note;
        remap[l.id] = existing.id;
      }
      const reId = (n) => ({
        ...n,
        id: uuid(),
        links: [...new Set(n.links.map((id) => remap[id]).filter(Boolean))],
        children: n.children.map(reId),
      });
      for (const c of incoming.collections) s.collections.push(reId(c));
    });
  }

  exportMarkdown(collectionId) {
    return collectionToMarkdown(this.state, collectionId);
  }

  /** Import a markdown outline as a new collection. Returns the new collection id. */
  importMarkdown(text, fallbackName = 'Imported') {
    const { name, root } = parseMarkdown(text);
    return this.mutate((s) => {
      const t = Date.now();
      const refFor = (item) => {
        const norm = normalizeUrl(item.url);
        if (!norm) return null;
        let l = Object.values(s.links).find((x) => x.url === norm);
        if (!l) {
          l = { id: uuid(), url: norm, name: item.name || nameFromUrl(norm), note: item.note || '', created: t, updated: t };
          s.links[l.id] = l;
        } else if (!l.note && item.note) l.note = item.note;
        return l.id;
      };
      const build = (src, node) => {
        for (const it of src.items) {
          const id = refFor(it);
          if (id && !node.links.includes(id)) node.links.push(id);
        }
        for (const ch of src.children) {
          const h = newHeading(ch.title);
          if (ch.note) h.note = ch.note;
          node.children.push(h);
          build(ch, h);
        }
        return node;
      };
      const col = { id: uuid(), name: name || fallbackName, links: [], children: [] };
      build(root, col);
      s.collections.push(col);
      return col.id;
    });
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function insertAt(arr, item, index) {
  if (index == null || index > arr.length) arr.push(item);
  else arr.splice(Math.max(0, index), 0, item);
}

/** Put linkId into container at index (moving it if it's already there). Returns true if it was new. */
function placeRef(s, linkId, containerId, index) {
  const c = findContainer(s, containerId);
  if (!c) throw new Error('No such container');
  const arr = c.node.links;
  const existing = arr.indexOf(linkId);
  if (existing >= 0) {
    if (index == null) return false;
    arr.splice(existing, 1);
    if (existing < index) index--;
    insertAt(arr, linkId, index);
    return false;
  }
  insertAt(arr, linkId, index);
  return true;
}
