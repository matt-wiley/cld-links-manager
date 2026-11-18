import { Store, normalizeUrl, MAX_DEPTH, countLinks, walkContainers } from './store.js';

// ---------- setup ----------

function safeStorage() {
  try {
    const k = '__linkshelf_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return localStorage;
  } catch {
    return null;
  }
}
const storage = safeStorage();
const store = new Store({ storage });
const UI_KEY = 'linkshelf:ui';
let ui = loadUi();
let query = '';
let pendingFlash = null; // { linkId, containerId }

function loadUi() {
  try {
    return { view: { type: 'library' }, target: null, lastLocation: null, ...JSON.parse(storage?.getItem(UI_KEY) || '{}') };
  } catch {
    return { view: { type: 'library' }, target: null, lastLocation: null };
  }
}
function saveUi() {
  try {
    storage?.setItem(UI_KEY, JSON.stringify(ui));
  } catch {}
}

// ---------- helpers ----------

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const I = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  heading: '<svg viewBox="0 0 24 24"><path d="M5 5v14M14 5v14M5 12h9M18 13l2-1v7"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/></svg>',
  library: '<svg viewBox="0 0 24 24"><path d="M5 4v16M10 4v16M15 5l4 15"/></svg>',
  inbox: '<svg viewBox="0 0 24 24"><path d="M4 13h4l2 3h4l2-3h4M5 5h14l1 8v6H4v-6z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M4 6h6l2 2h8v10H4z"/></svg>',
};

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}
function hue(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
function safeHref(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'mailto:', 'tel:', 'ftp:', 'file:'].includes(u.protocol) ? u.href : '#';
  } catch {
    return '#';
  }
}
function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (m) => `<a href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`);
}
function isTyping() {
  const a = document.activeElement;
  return !!a && (a.matches('input, textarea, select') || a.isContentEditable);
}
function dialogOpen() {
  return !!document.querySelector('dialog[open]');
}
function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileSafe = (s) => String(s).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'links';

function currentCollection() {
  return ui.view.type === 'collection' ? store.getCollection(ui.view.id) : null;
}
/** The container quick-add and paste go into: the selected heading, else the collection root. */
function targetId() {
  const col = currentCollection();
  if (!col) return null;
  if (ui.target) {
    const t = store.container(ui.target);
    if (t && t.collection.id === col.id) return ui.target;
  }
  return col.id;
}
function containerLabel(id) {
  const c = store.container(id);
  if (!c) return '';
  if (c.depth === 0) return c.collection.name;
  return [c.collection.name, ...c.path.map((h) => h.title), c.node.title].join(' › ');
}
function containerShortLabel(id) {
  const c = store.container(id);
  if (!c) return '';
  return c.depth === 0 ? c.collection.name : c.node.title;
}

// ---------- toasts ----------

function toast(message, { action, onAction, error = false, timeout = 5000 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.append(Object.assign(document.createElement('span'), { textContent: message }));
  const actions = Array.isArray(action) ? action : action ? [{ label: action, run: onAction }] : [];
  for (const a of actions) {
    const b = Object.assign(document.createElement('button'), { textContent: a.label, type: 'button' });
    b.onclick = () => {
      a.run();
      el.remove();
    };
    el.append(b);
  }
  const host = $('#toasts');
  host.append(el);
  while (host.children.length > 3) host.firstElementChild.remove();
  setTimeout(() => el.remove(), timeout);
}
const undoAction = { label: 'Undo', run: () => store.undo() };
function fail(err) {
  console.error(err);
  toast(err?.message || String(err), { error: true });
}

// ---------- generic ask / confirm dialog ----------

let askResolve = null;
function ask({ title, message = '', label = '', value = '', input = true, ok = 'OK', danger = false, alt = null }) {
  const d = $('#ask-dialog');
  $('#ask-title').textContent = title;
  $('#ask-message').textContent = message;
  $('#ask-message').hidden = !message;
  $('#ask-label').hidden = !input;
  $('#ask-label-text').textContent = label;
  const inp = d.querySelector('input[name=value]');
  inp.value = value;
  inp.required = input;
  const okBtn = $('#ask-ok');
  okBtn.textContent = ok;
  okBtn.className = 'btn ' + (danger ? 'danger' : 'primary');
  const altBtn = $('#ask-alt');
  altBtn.hidden = !alt;
  altBtn.textContent = alt || '';
  return new Promise((resolve) => {
    askResolve = resolve;
    d.showModal();
    if (input) {
      inp.focus();
      inp.select();
    } else okBtn.focus();
  });
}
function finishAsk(result) {
  const r = askResolve;
  askResolve = null;
  $('#ask-dialog').close();
  r?.(result);
}
$('#ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  finishAsk({ ok: true, value: $('#ask-form').value.value.trim() });
});
$('#ask-alt').addEventListener('click', () => finishAsk({ ok: false, alt: true }));
$('#ask-dialog').addEventListener('close', () => askResolve && finishAsk({ ok: false }));

// ---------- link dialog ----------

let linkDlg = null; // { mode: 'add'|'edit', linkId, dirty }

function locationOptions(selected, { blankLabel }) {
  let html = `<option value="">${esc(blankLabel)}</option>`;
  for (const { node, depth } of walkContainers(store.state)) {
    const label = depth === 0 ? node.name : ' '.repeat(depth) + node.title;
    html += `<option value="${node.id}"${node.id === selected ? ' selected' : ''}>${esc(label)}</option>`;
  }
  return html;
}

function openLinkDialog({ linkId = null, containerId = null, url = '', name = '', note = '' } = {}) {
  const d = $('#link-dialog');
  const f = $('#link-form');
  const link = linkId ? store.getLink(linkId) : null;
  linkDlg = { mode: link ? 'edit' : 'add', linkId: link?.id || null, dirty: false };
  $('#link-dialog-title').textContent = link ? 'Edit link' : 'Add link';
  f.url.value = link?.url ?? url;
  f.name.value = link?.name ?? name;
  f.note.value = link?.note ?? note;
  f.url.setCustomValidity('');
  $('#link-location-text').textContent = link ? 'Also add to' : 'Save to';
  const defaultLoc = link ? '' : (containerId ?? targetId() ?? ui.lastLocation ?? '');
  f.location.innerHTML = locationOptions(store.container(defaultLoc) ? defaultLoc : '', {
    blankLabel: link ? '—' : 'Library only (not in a collection)',
  });
  $('#link-delete').hidden = !link;
  renderDialogRefs();
  checkDupe();
  d.showModal();
  (f.url.value ? f.name : f.url).focus();
  if (f.url.value) f.name.select();
}

function renderDialogRefs() {
  const el = $('#link-refs');
  if (linkDlg?.mode !== 'edit') {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = refsHtml(linkDlg.linkId, { prefix: 'Appears in: ' });
}

function checkDupe() {
  const f = $('#link-form');
  const notice = $('#link-dupe');
  const norm = normalizeUrl(f.url.value);
  const existing = norm ? store.getLinkByUrl(norm) : null;
  notice.hidden = true;
  if (!existing || existing.id === linkDlg?.linkId) return;
  const where = store.refs(existing.id).map((r) => containerLabel(r.container.id));
  if (linkDlg.mode === 'add') {
    notice.textContent = `Already saved as “${existing.name}”${where.length ? ` (in ${where.join('; ')})` : ''}. Saving updates it and adds it to the place below.`;
    if (!linkDlg.dirty) {
      f.name.value = existing.name;
      f.note.value = existing.note || f.note.value;
    }
  } else {
    notice.textContent = `Another saved link (“${existing.name}”) has this URL. Saving merges the two.`;
  }
  notice.hidden = false;
}

$('#link-form').url.addEventListener('input', () => {
  $('#link-form').url.setCustomValidity('');
  checkDupe();
});
for (const n of ['name', 'note']) $('#link-form')[n].addEventListener('input', () => linkDlg && (linkDlg.dirty = true));
$('#link-form').note.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#link-form').requestSubmit();
});

$('#link-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const url = f.url.value.trim();
  if (!normalizeUrl(url)) {
    f.url.setCustomValidity('Enter a valid URL, e.g. https://example.com');
    f.url.reportValidity();
    return;
  }
  const loc = f.location.value || null;
  try {
    if (linkDlg.mode === 'add') {
      const r = store.saveLink({ url, name: f.name.value, note: f.note.value }, { containerId: loc });
      ui.lastLocation = loc;
      saveUi();
      pendingFlash = loc ? { linkId: r.link.id, containerId: loc } : null;
      afterAddToast(r.link, loc, r.created, r.placed);
    } else {
      store.mutate(() => {
        const id = store.updateLink(linkDlg.linkId, { url, name: f.name.value, note: f.note.value });
        if (loc) store.moveLink(id, null, loc);
      });
      if (loc) toast(`Also added to ${containerShortLabel(loc)}`, { action: [undoAction] });
    }
    $('#link-dialog').close();
    render();
  } catch (err) {
    fail(err);
  }
});

$('#link-delete').addEventListener('click', async () => {
  const link = store.getLink(linkDlg.linkId);
  const n = store.refs(link.id).length;
  $('#link-dialog').close();
  const r = await ask({
    title: 'Delete link?',
    message: `“${link.name}” will be removed from your library${n ? ` and from ${n} place${n > 1 ? 's' : ''} it appears` : ''}.`,
    input: false,
    ok: 'Delete',
    danger: true,
  });
  if (!r.ok) return;
  store.deleteLink(link.id);
  toast('Link deleted', { action: [undoAction] });
});

// ---------- adding links ----------

/** Pull {url, name} pairs out of pasted / dropped text. */
function extractUrls(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const md = [...t.matchAll(/\[([^\]]*)\]\((\S+?)\)/g)].filter((m) => normalizeUrl(m[2]));
    if (md.length) {
      for (const m of md) out.push({ url: m[2], name: m[1] });
      continue;
    }
    const [first, ...rest] = t.split(/\s+/);
    if (normalizeUrl(first)) {
      out.push({ url: first, name: rest.join(' ').replace(/^[-–—:|]\s*/, '') });
      continue;
    }
    for (const u of t.match(/https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/g) || []) out.push({ url: u, name: '' });
  }
  return out;
}

function afterAddToast(link, containerId, created, placed) {
  const where = containerId ? containerShortLabel(containerId) : 'your library';
  const msg = created
    ? `Added “${link.name}” to ${where}`
    : placed
      ? `Already saved, now also in ${where}`
      : containerId
        ? `“${link.name}” is already in ${where}`
        : `Updated “${link.name}”`;
  toast(msg, {
    action: [{ label: 'Edit', run: () => openLinkDialog({ linkId: link.id }) }, ...(created || placed ? [undoAction] : [])],
  });
}

/** Add several links at once (one undo step). index = insert position inside container. */
function addUrls(items, containerId, index = null) {
  items = items.filter((i) => normalizeUrl(i.url));
  if (!items.length) {
    toast('No links found in that', { error: true });
    return;
  }
  try {
    if (!containerId && store.state.collections.length === 0) {
      containerId = store.addCollection('Inbox');
      ui.view = { type: 'collection', id: containerId };
      saveUi();
    }
    const results = store.mutate(() =>
      items.map((it, k) => store.saveLink({ url: it.url, name: it.name || undefined }, { containerId, index: index == null ? null : index + k }))
    );
    if (results.length === 1) {
      const r = results[0];
      pendingFlash = containerId ? { linkId: r.link.id, containerId } : null;
      afterAddToast(r.link, containerId, r.created, r.placed);
    } else {
      const created = results.filter((r) => r.created).length;
      toast(`Added ${results.length} links${created < results.length ? ` (${results.length - created} already saved)` : ''} to ${containerId ? containerShortLabel(containerId) : 'your library'}`, {
        action: [undoAction],
      });
    }
    render();
  } catch (err) {
    fail(err);
  }
}

// ---------- rendering ----------

function refsHtml(linkId, { prefix = '' } = {}) {
  const refs = store.refs(linkId);
  if (!refs.length) return `<div class="link-refs">${esc(prefix)}<span class="ref-chip orphan">Not in any collection</span></div>`;
  return `<div class="link-refs">${prefix ? `<span class="muted">${esc(prefix)}</span>` : ''}${refs
    .map(
      (r) =>
        `<button type="button" class="ref-chip" data-action="goto-ref" data-collection="${r.collection.id}" data-container="${r.container.id}" data-link="${linkId}">${esc(containerLabel(r.container.id))}</button>`
    )
    .join('')}</div>`;
}

function renderLinkRow(id, containerId, { showRefs = false } = {}) {
  const l = store.getLink(id);
  if (!l) return '';
  const host = hostOf(l.url);
  const initial = (host || l.name || '?').replace(/^[^a-z0-9]+/i, '')[0] || '?';
  return `<li class="link-row" draggable="true" data-link="${l.id}" data-container="${containerId || ''}">
    <span class="avatar" style="--h:${hue(host || l.url)}" aria-hidden="true">${esc(initial)}</span>
    <div class="link-main">
      <div class="link-line">
        <a class="link-name" href="${esc(safeHref(l.url))}" target="_blank" rel="noopener noreferrer" draggable="false" title="${esc(l.url)}">${esc(l.name)}</a>
        <span class="link-host">${esc(host || l.url)}</span>
      </div>
      ${l.note ? `<div class="link-note">${linkify(l.note)}</div>` : ''}
      ${showRefs ? refsHtml(l.id) : ''}
    </div>
    <span class="row-actions">
      <button class="icon-btn" data-action="copy-url" data-link="${l.id}" title="Copy URL" aria-label="Copy URL">${I.copy}</button>
      <button class="icon-btn" data-action="edit-link" data-link="${l.id}" title="Edit name, note, URL" aria-label="Edit">${I.edit}</button>
      ${
        containerId
          ? `<button class="icon-btn" data-action="remove-ref" data-link="${l.id}" data-container="${containerId}" title="Remove from here (stays in library)" aria-label="Remove from here">${I.x}</button>`
          : `<button class="icon-btn" data-action="delete-link" data-link="${l.id}" title="Delete everywhere" aria-label="Delete">${I.trash}</button>`
      }
    </span>
  </li>`;
}

function renderBody(node, depth, target) {
  const links = node.links.map((id) => renderLinkRow(id, node.id)).join('');
  const kids = node.children.map((h) => renderHeading(h, depth + 1, target)).join('');
  const empty = !node.links.length && !node.children.length;
  const emptyMsg =
    depth === 0
      ? `Nothing here yet. Paste a URL (${isMac ? '⌘' : 'Ctrl+'}V), drop a link from another window, or add a heading.`
      : 'Empty. Drop links here, or select this heading and paste.';
  return `<div class="container-body" data-container="${node.id}">
    ${links ? `<ul class="links">${links}</ul>` : ''}
    ${empty ? `<div class="empty-drop">${esc(emptyMsg)}</div>` : ''}
    ${kids}
  </div>`;
}

function renderHeading(h, depth, target) {
  const tag = 'h' + Math.min(depth + 1, 6);
  const n = countLinks(h);
  return `<section class="heading-section d${depth}${h.collapsed ? ' collapsed' : ''}" data-section="${h.id}">
    <div class="heading-header${target === h.id ? ' is-target' : ''}" draggable="true" data-heading="${h.id}" title="Click to add new links here · drag to reorder or nest">
      <button class="twisty" data-action="toggle" data-id="${h.id}" aria-label="${h.collapsed ? 'Expand' : 'Collapse'}" aria-expanded="${!h.collapsed}">${I.chevron}</button>
      <${tag} class="heading-title" data-id="${h.id}">${esc(h.title)}</${tag}>
      <span class="heading-count">${n || ''}</span>
      <span class="row-actions">
        <button class="icon-btn" data-action="add-link" data-container="${h.id}" title="Add link here" aria-label="Add link here">${I.plus}</button>
        ${depth < MAX_DEPTH ? `<button class="icon-btn" data-action="add-heading" data-parent="${h.id}" title="Add sub-heading" aria-label="Add sub-heading">${I.heading}</button>` : ''}
        <button class="icon-btn" data-action="rename-heading" data-id="${h.id}" title="Rename" aria-label="Rename">${I.edit}</button>
        <button class="icon-btn" data-action="delete-heading" data-id="${h.id}" title="Delete heading" aria-label="Delete heading">${I.trash}</button>
      </span>
    </div>
    ${renderBody(h, depth, target)}
  </section>`;
}

function quickAddHtml(target) {
  const col = currentCollection();
  const chip = col
    ? `<button type="button" class="target-chip" data-action="clear-target" title="${target !== col.id ? 'New links go into this heading. Click to add to the top of the collection instead.' : 'Click a heading to add links into it'}">→ ${esc(containerShortLabel(target))}${target !== col.id ? ' ✕' : ''}</button>`
    : '';
  return `<form class="quick-add" id="quick-add" autocomplete="off">
    ${I.plus}
    <input id="quick-input" data-focus-key="quick" placeholder="Paste or type a URL, optionally followed by a name" spellcheck="false" aria-label="Add a link" />
    ${chip}
    <span class="hint"><kbd>↵</kbd></span>
  </form>`;
}

function renderCollectionView(col) {
  const target = targetId();
  return `<header class="view-header">
      <h1 class="view-title" contenteditable="true" spellcheck="false" data-edit="collection" data-id="${col.id}">${esc(col.name)}</h1>
      <div class="view-actions">
        <button class="icon-btn" data-action="add-heading" data-parent="${col.id}" title="Add heading" aria-label="Add heading">${I.heading}</button>
        <button class="icon-btn" data-action="export-md" data-id="${col.id}" title="Export as markdown" aria-label="Export as markdown">${I.download}</button>
        <button class="icon-btn" data-action="delete-collection" data-id="${col.id}" title="Delete collection" aria-label="Delete collection">${I.trash}</button>
      </div>
    </header>
    ${quickAddHtml(target)}
    <div class="tree">${renderBody(col, 0, target)}</div>
    <div class="add-heading-row"><button class="btn subtle" data-action="add-heading" data-parent="${col.id}">${I.plus} Add heading</button></div>`;
}

function renderListView(title, sub, ids, { quickAdd = false, empty = '' } = {}) {
  return `<header class="view-header"><h1 class="view-title">${esc(title)}</h1></header>
    ${sub ? `<p class="view-sub">${sub}</p>` : ''}
    ${quickAdd ? quickAddHtml(null) : ''}
    ${ids.length ? `<ul class="links">${ids.map((id) => renderLinkRow(id, null, { showRefs: true })).join('')}</ul>` : `<p class="empty-hint">${esc(empty)}</p>`}`;
}

function renderWelcome() {
  return `<div class="welcome">
    <h1>Welcome to Linkshelf</h1>
    <p>Organize the links you actually use into collections and nested headings, with notes. Everything stays in this browser. No account, no server.</p>
    <div class="btn-row" style="justify-content:center">
      <button class="btn primary" data-action="new-collection">${I.plus} Create a collection</button>
      <button class="btn" data-action="load-sample">Explore with sample data</button>
    </div>
    <ul class="tips">
      <li><b>Paste anywhere</b>: copy a URL and press ${isMac ? '⌘V' : 'Ctrl+V'} on this page.</li>
      <li><b>Drag in</b> links from other windows, and <b>drag to organize</b>: reorder, nest headings, move between collections (hold ${isMac ? '⌥' : 'Alt'} to copy).</li>
      <li><b>One link, many places</b>: links are stored once by URL, so editing one updates it everywhere.</li>
      <li><b>Bookmarklet</b>: save the page you're on in one click (see sidebar).</li>
    </ul>
  </div>`;
}

function renderView() {
  const view = $('#view');
  const linkIds = Object.keys(store.state.links);
  if (query) {
    const results = store.search(query);
    view.innerHTML = renderListView(
      `Search`,
      `${results.length} result${results.length === 1 ? '' : 's'} for “${esc(query)}”${results.length ? ' · Enter opens the first one' : ''}`,
      results.map((l) => l.id),
      { empty: 'Nothing matches. Search covers names, URLs and notes.' }
    );
    return;
  }
  if (!store.state.collections.length && !linkIds.length) {
    view.innerHTML = renderWelcome();
    return;
  }
  const col = currentCollection();
  if (col) {
    view.innerHTML = renderCollectionView(col);
    return;
  }
  if (ui.view.type === 'unfiled') {
    view.innerHTML = renderListView(
      'Unfiled',
      'Saved links that aren’t in any collection. Drag one onto a collection in the sidebar to file it.',
      store.orphanIds().sort((a, b) => store.getLink(b).updated - store.getLink(a).updated),
      { quickAdd: true, empty: 'Everything is filed.' }
    );
    return;
  }
  const ids = linkIds.sort((a, b) => store.getLink(b).created - store.getLink(a).created);
  view.innerHTML = renderListView(
    'All links',
    `${ids.length} saved link${ids.length === 1 ? '' : 's'}, newest first. Each is stored once and can appear in many places. Drag onto a collection in the sidebar to add it there.`,
    ids,
    { quickAdd: true, empty: 'No links yet. Paste one above.' }
  );
}

function renderSidebar() {
  const total = Object.keys(store.state.links).length;
  const orphans = store.orphanIds().length;
  const v = query ? 'search' : ui.view.type;
  $('#nav').innerHTML = `
    <button class="nav-item${v === 'library' ? ' active' : ''}" data-action="view" data-view="library">${I.library}<span class="label">All links</span><span class="count">${total || ''}</span></button>
    ${orphans || v === 'unfiled' ? `<button class="nav-item${v === 'unfiled' ? ' active' : ''}" data-action="view" data-view="unfiled">${I.inbox}<span class="label">Unfiled</span><span class="count">${orphans || ''}</span></button>` : ''}`;
  const cols = store.state.collections;
  $('#collections').innerHTML = cols.length
    ? cols
        .map(
          (c) =>
            `<li><div class="nav-item coll-item${v === 'collection' && ui.view.id === c.id ? ' active' : ''}" role="button" tabindex="0" draggable="true" data-action="open-collection" data-collection="${c.id}">${I.folder}<span class="label">${esc(c.name)}</span><span class="count">${countLinks(c) || ''}</span></div></li>`
        )
        .join('')
    : `<li class="sidebar-empty">No collections yet</li>`;
  $('#undo-btn').disabled = !store.canUndo;
  $('#redo-btn').disabled = !store.canRedo;
  const bytes = (storage?.getItem(store.key) || '').length;
  $('#storage-meter').textContent = storage
    ? `${total} link${total === 1 ? '' : 's'} · ${bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(1) + ' KB'} in local storage`
    : '⚠ Local storage unavailable: changes won’t be saved';
}

function captureFocus() {
  const a = document.activeElement;
  const key = a?.dataset?.focusKey;
  if (!key) return null;
  return { key, start: a.selectionStart, end: a.selectionEnd, value: a.value };
}
function restoreFocus(f) {
  if (!f) return;
  const el = document.querySelector(`[data-focus-key="${f.key}"]`);
  if (!el || el === document.activeElement) return;
  el.focus();
  if (f.value != null && el.value === '' && f.key !== 'quick') el.value = f.value;
  try {
    el.setSelectionRange(f.start, f.end);
  } catch {}
}

function validateUi() {
  if (ui.view.type === 'collection' && !store.getCollection(ui.view.id)) {
    const first = store.state.collections[0];
    ui.view = first ? { type: 'collection', id: first.id } : { type: 'library' };
    ui.target = null;
  }
  if (ui.target && !store.container(ui.target)) ui.target = null;
}

function render() {
  const focus = captureFocus();
  validateUi();
  renderSidebar();
  renderView();
  restoreFocus(focus);
  document.title = currentCollection() && !query ? `${currentCollection().name} · Linkshelf` : 'Linkshelf';
  if (pendingFlash) {
    const { linkId, containerId } = pendingFlash;
    pendingFlash = null;
    const row = document.querySelector(`.link-row[data-link="${linkId}"][data-container="${containerId}"]`);
    if (row) {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      row.classList.add('flash');
    }
  }
}

store.subscribe(() => render());

// ---------- navigation ----------

function setView(view) {
  ui.view = view;
  if (view.type !== 'collection') ui.target = null;
  query = '';
  $('#search').value = '';
  saveUi();
  document.body.classList.remove('sidebar-open');
  render();
  $('#main').scrollTop = 0;
}
function openCollection(id) {
  if (ui.view.type !== 'collection' || ui.view.id !== id) ui.target = null;
  setView({ type: 'collection', id });
}
function setTarget(id) {
  ui.target = id;
  saveUi();
  render();
}

function gotoRef(collectionId, containerId, linkId) {
  // expand the path so the link is visible
  const c = store.container(containerId);
  if (c) for (const h of [...c.path, ...(c.depth ? [c.node] : [])]) if (h.collapsed) store.toggleCollapsed(h.id, false);
  pendingFlash = { linkId, containerId };
  ui.target = c && c.depth ? containerId : null;
  setView({ type: 'collection', id: collectionId });
}

// ---------- inline editing ----------

function inlineEdit(el, onCommit) {
  if (el.isContentEditable) return;
  const original = el.textContent;
  const header = el.closest('[draggable]');
  header?.setAttribute('draggable', 'false');
  el.contentEditable = 'true';
  el.focus();
  document.getSelection().selectAllChildren(el);
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    el.removeEventListener('keydown', onKey);
    el.removeEventListener('blur', onBlur);
    el.contentEditable = 'false';
    header?.setAttribute('draggable', 'true');
    const v = el.textContent.replace(/\s+/g, ' ').trim();
    if (commit && v && v !== original) onCommit(v);
    else el.textContent = original;
  };
  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  };
  const onBlur = () => finish(true);
  el.addEventListener('keydown', onKey);
  el.addEventListener('blur', onBlur);
}

// collection title is always editable
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement) || t.dataset.edit !== 'collection') return;
  if (e.key === 'Enter') {
    e.preventDefault();
    t.blur();
  } else if (e.key === 'Escape') {
    t.textContent = store.getCollection(t.dataset.id)?.name ?? '';
    t.blur();
  }
});
document.addEventListener('focusout', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement) || t.dataset.edit !== 'collection') return;
  const v = t.textContent.replace(/\s+/g, ' ').trim();
  const col = store.getCollection(t.dataset.id);
  if (!col) return;
  if (v && v !== col.name) store.renameCollection(col.id, v);
  else t.textContent = col.name;
});
document.addEventListener('paste', (e) => {
  // keep contenteditable titles plain-text
  const t = e.target instanceof HTMLElement ? e.target.closest('[contenteditable="true"]') : null;
  if (!t) return;
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\s+/g, ' '));
});

// ---------- actions ----------

const actions = {
  view: (el) => setView({ type: el.dataset.view }),
  'open-collection': (el) => openCollection(el.dataset.collection),
  async 'new-collection'() {
    const r = await ask({ title: 'New collection', label: 'Name', value: '', ok: 'Create' });
    if (!r.ok || !r.value) return;
    openCollection(store.addCollection(r.value));
  },
  async 'add-heading'(el) {
    const parent = el.dataset.parent;
    const p = store.container(parent);
    const r = await ask({
      title: p.depth === 0 ? 'New heading' : `New sub-heading in “${p.node.title}”`,
      label: 'Heading',
      ok: 'Add',
    });
    if (!r.ok || !r.value) return;
    try {
      if (p.depth > 0 && p.node.collapsed) store.toggleCollapsed(parent, false);
      const id = store.addHeading(parent, r.value);
      setTarget(id);
    } catch (err) {
      fail(err);
    }
  },
  'rename-heading'(el) {
    const title = document.querySelector(`.heading-title[data-id="${el.dataset.id}"]`);
    if (title) inlineEdit(title, (v) => store.renameHeading(el.dataset.id, v));
  },
  async 'delete-heading'(el) {
    const c = store.container(el.dataset.id);
    if (!c) return;
    const n = countLinks(c.node);
    const subs = c.node.children.length;
    if (!n && !subs) {
      store.deleteHeading(c.node.id);
      toast(`Deleted “${c.node.title}”`, { action: [undoAction] });
      return;
    }
    const r = await ask({
      title: `Delete “${c.node.title}”?`,
      message: `It contains ${n} link${n === 1 ? '' : 's'}${subs ? ` and ${subs} sub-heading${subs === 1 ? '' : 's'}` : ''}. Links always stay in your library.`,
      input: false,
      ok: 'Delete with contents',
      danger: true,
      alt: 'Keep contents',
    });
    if (!r.ok && !r.alt) return;
    store.deleteHeading(c.node.id, { keepContents: !!r.alt });
    toast(`Deleted “${c.node.title}”`, { action: [undoAction] });
  },
  toggle: (el) => store.toggleCollapsed(el.dataset.id),
  'add-link': (el) => openLinkDialog({ containerId: el.dataset.container }),
  'edit-link': (el) => openLinkDialog({ linkId: el.dataset.link }),
  'remove-ref'(el) {
    const name = store.getLink(el.dataset.link)?.name;
    store.removeRef(el.dataset.container, el.dataset.link);
    toast(`Removed “${name}” from ${containerShortLabel(el.dataset.container)}`, { action: [undoAction] });
  },
  async 'delete-link'(el) {
    const link = store.getLink(el.dataset.link);
    const n = store.refs(link.id).length;
    const r = await ask({
      title: 'Delete link?',
      message: `“${link.name}” will be removed from your library${n ? ` and from ${n} place${n > 1 ? 's' : ''} it appears` : ''}.`,
      input: false,
      ok: 'Delete',
      danger: true,
    });
    if (!r.ok) return;
    store.deleteLink(link.id);
    toast('Link deleted', { action: [undoAction] });
  },
  async 'copy-url'(el) {
    const l = store.getLink(el.dataset.link);
    try {
      await navigator.clipboard.writeText(l.url);
      toast('URL copied');
    } catch {
      toast('Could not access the clipboard', { error: true });
    }
  },
  'goto-ref': (el) => gotoRef(el.dataset.collection, el.dataset.container, el.dataset.link),
  'clear-target'() {
    if (ui.target) setTarget(null);
    else toast('Click a heading to add new links into it');
  },
  'export-md'(el) {
    const col = store.getCollection(el.dataset.id);
    download(`${fileSafe(col.name)}.md`, store.exportMarkdown(col.id), 'text/markdown');
  },
  async 'delete-collection'(el) {
    const col = store.getCollection(el.dataset.id);
    const n = countLinks(col);
    const r = await ask({
      title: `Delete “${col.name}”?`,
      message: `The collection and its headings go away. ${n ? `Its ${n} link${n === 1 ? '' : 's'} stay in your library.` : ''}`,
      input: false,
      ok: 'Delete collection',
      danger: true,
    });
    if (!r.ok) return;
    store.deleteCollection(col.id);
    toast(`Deleted “${col.name}”`, { action: [undoAction] });
  },
  undo: () => store.undo() || toast('Nothing to undo'),
  redo: () => store.redo() || toast('Nothing to redo'),
  'open-io': () => $('#io-dialog').showModal(),
  'open-bookmarklet'() {
    $('#bookmarklet').href = bookmarkletCode();
    $('#bm-dialog').showModal();
  },
  'open-help': () => $('#help-dialog').showModal(),
  'export-json': () => download(`linkshelf-backup-${new Date().toISOString().slice(0, 10)}.json`, store.exportJSON(), 'application/json'),
  'export-md-all'() {
    const md = store.state.collections.map((c) => store.exportMarkdown(c.id)).join('\n\n');
    download('linkshelf-collections.md', md, 'text/markdown');
  },
  'import-pasted'() {
    const text = $('#import-text').value;
    if (!text.trim()) return;
    try {
      const id = store.importMarkdown(text, 'Imported');
      $('#import-text').value = '';
      $('#io-dialog').close();
      openCollection(id);
      toast('Imported', { action: [undoAction] });
    } catch (err) {
      fail(err);
    }
  },
  async wipe() {
    $('#io-dialog').close();
    const r = await ask({
      title: 'Erase all data?',
      message: 'Every link and collection in this browser will be removed. You can undo right afterwards, but consider exporting a backup first.',
      input: false,
      ok: 'Erase everything',
      danger: true,
    });
    if (!r.ok) return;
    store.mutate((s) => {
      s.links = {};
      s.collections = [];
    });
    setView({ type: 'library' });
    toast('All data erased', { action: [undoAction], timeout: 10000 });
  },
  'toggle-sidebar': () => document.body.classList.toggle('sidebar-open'),
  'cycle-theme'() {
    const order = ['system', 'light', 'dark'];
    setTheme(order[(order.indexOf(getTheme()) + 1) % order.length]);
    toast(`Theme: ${THEMES[getTheme()].label}`, { timeout: 1500 });
  },
  'load-sample'() {
    const id = store.importMarkdown(SAMPLE, 'My App');
    openCollection(id);
  },
};

document.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  if (t.closest('[data-close]')) {
    t.closest('dialog')?.close();
    return;
  }
  const el = t.closest('[data-action]');
  if (el) {
    const fn = actions[el.dataset.action];
    if (fn) {
      e.preventDefault();
      Promise.resolve(fn(el, e)).catch(fail);
    }
    return;
  }
  // clicking a heading selects it as the place new links go
  const hh = t.closest('.heading-header');
  if (hh && !t.closest('[contenteditable="true"]')) setTarget(ui.target === hh.dataset.heading ? null : hh.dataset.heading);
});
document.addEventListener('dblclick', (e) => {
  const title = e.target instanceof Element && e.target.closest('.heading-title');
  if (title) inlineEdit(title, (v) => store.renameHeading(title.dataset.id, v));
});
// role=button elements (draggable collection items) respond to keyboard
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLElement && e.target.getAttribute('role') === 'button') {
    e.preventDefault();
    e.target.click();
  }
});
// close a dialog by clicking its backdrop
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('mousedown', (e) => {
    if (e.target === d) d.close();
  });
}

// quick add
document.addEventListener('submit', (e) => {
  if (e.target.id !== 'quick-add') return;
  e.preventDefault();
  const input = $('#quick-input');
  const v = input.value.trim();
  if (!v) return;
  const items = extractUrls(v);
  if (!items.length) {
    toast('That doesn’t look like a URL', { error: true });
    return;
  }
  input.value = '';
  addUrls(items, targetId());
});

// search
$('#search').addEventListener('input', (e) => {
  query = e.target.value.trim();
  document.body.classList.remove('sidebar-open');
  render();
});
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.target.value = '';
    query = '';
    e.target.blur();
    render();
  } else if (e.key === 'Enter' && query) {
    const first = store.search(query)[0];
    if (first) window.open(safeHref(first.url), '_blank', 'noopener');
  }
});

// keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (dialogOpen() || e.defaultPrevented) return;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z' && !isTyping()) {
    e.preventDefault();
    if (e.shiftKey) store.redo();
    else store.undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y' && !isTyping()) {
    e.preventDefault();
    store.redo();
    return;
  }
  if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') {
    e.preventDefault();
    $('#search').focus();
  } else if (e.key === 'n') {
    e.preventDefault();
    const q = $('#quick-input');
    if (q) q.focus();
    else openLinkDialog();
  } else if (e.key === 'Escape' && ui.target) {
    setTarget(null);
  }
});

// paste anywhere
document.addEventListener('paste', (e) => {
  if (isTyping() || dialogOpen()) return;
  const items = extractUrls(e.clipboardData?.getData('text/plain'));
  if (!items.length) return;
  e.preventDefault();
  addUrls(items, targetId());
});

// ---------- drag and drop ----------

let drag = null; // { kind: 'link', linkId, from } | { kind: 'heading', id } | { kind: 'collection', id }
let indicator = null; // { el, cls }
let lastDragOver = 0;
let expandTimer = null;
let expandEl = null;
const expandedDuringDrag = new Set();

const OWN_TYPE = 'application/x-linkshelf';
const isExternal = (dt) => {
  const types = [...(dt?.types || [])];
  return !types.includes(OWN_TYPE) && (types.includes('text/uri-list') || types.includes('text/x-moz-url') || types.includes('Files') || types.includes('text/plain'));
};

function setIndicator(t) {
  const el = t?.el || null;
  const cls = t?.cls || null;
  if (indicator && indicator.el === el && indicator.cls === cls) return;
  if (indicator?.el) indicator.el.classList.remove(indicator.cls);
  indicator = el && cls ? { el, cls } : null;
  if (indicator) el.classList.add(cls);
}

function endDrag() {
  setIndicator(null);
  clearTimeout(expandTimer);
  expandEl = null;
  document.querySelectorAll('.dragging-source').forEach((el) => el.classList.remove('dragging-source'));
  document.body.classList.remove('is-dragging', 'is-dragging-external');
  drag = null;
  if (expandedDuringDrag.size) {
    const ids = [...expandedDuringDrag];
    expandedDuringDrag.clear();
    for (const id of ids) store.toggleCollapsed(id, false);
  }
}

document.addEventListener('dragstart', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  const src = t?.closest('.link-row, .heading-header, .coll-item');
  if (!src || t.closest('[contenteditable="true"]')) return;
  const dt = e.dataTransfer;
  dt.effectAllowed = 'copyMove';
  dt.setData(OWN_TYPE, '1');
  let faded = src;
  if (src.matches('.link-row')) {
    drag = { kind: 'link', linkId: src.dataset.link, from: src.dataset.container || null };
    const l = store.getLink(drag.linkId);
    dt.setData('text/uri-list', l.url);
    dt.setData('text/plain', l.url);
  } else if (src.matches('.heading-header')) {
    drag = { kind: 'heading', id: src.dataset.heading };
    dt.setData('text/plain', src.textContent.trim());
    faded = src.parentElement;
  } else {
    drag = { kind: 'collection', id: src.dataset.collection };
    dt.setData('text/plain', src.textContent.trim());
  }
  const started = drag;
  requestAnimationFrame(() => {
    if (drag !== started) return; // drag already ended
    faded.classList.add('dragging-source');
    document.body.classList.add('is-dragging');
  });
});
document.addEventListener('dragend', endDrag);
// if the source node got re-rendered away, dragend never reaches us
document.addEventListener('mousemove', () => {
  if ((drag || indicator) && Date.now() - lastDragOver > 400) endDrag();
});

function relY(e, el) {
  const r = el.getBoundingClientRect();
  return (e.clientY - r.top) / r.height;
}

function doMoveLink(d, toId, index, copy) {
  const fromCol = d.from ? store.container(d.from)?.collection.id : null;
  const toCol = store.container(toId)?.collection.id;
  store.moveLink(d.linkId, d.from, toId, index, { copy });
  if (!d.from) toast(`Added to ${containerShortLabel(toId)}`, { action: [undoAction] });
  else if (copy) toast(`Copied to ${containerShortLabel(toId)}`, { action: [undoAction] });
  else if (fromCol !== toCol) toast(`Moved to ${containerLabel(toId)}`, { action: [undoAction] });
}

/** Work out what dropping here would do. Returns { el, cls, apply(dataTransfer) } or null. */
function computeDrop(e, d) {
  const t = e.target instanceof Element ? e.target : e.target?.parentElement;
  if (!t) return null;
  const copy = e.altKey;
  const ext = d.kind === 'external';
  const linkish = d.kind === 'link' || ext;

  // sidebar collections
  const ci = t.closest('.coll-item');
  if (ci) {
    const cid = ci.dataset.collection;
    if (d.kind === 'collection') {
      if (cid === d.id) return null;
      const after = relY(e, ci) > 0.5;
      const idx = store.state.collections.findIndex((c) => c.id === cid) + (after ? 1 : 0);
      return { el: ci, cls: after ? 'drop-after' : 'drop-before', apply: () => store.moveCollection(d.id, idx) };
    }
    if (d.kind === 'heading') {
      if (store.canMoveHeading(d.id, cid)) return null;
      return { el: ci, cls: 'drop-inside', apply: () => store.moveHeading(d.id, cid) };
    }
    return { el: ci, cls: 'drop-inside', copy, apply: (dt) => (ext ? dropExternal(dt, cid) : doMoveLink(d, cid, null, copy)) };
  }
  if (d.kind === 'collection') return null;

  const inTree = t.closest('.tree');
  if (!inTree) {
    // external drops anywhere else in the main area go to the current target
    if (ext && t.closest('.main')) return { el: null, cls: null, apply: (dt) => dropExternal(dt, targetId()) };
    return null;
  }

  const row = t.closest('.link-row');
  if (row && linkish) {
    const cid = row.dataset.container;
    const ids = store.container(cid)?.node.links || [];
    const after = relY(e, row) > 0.5;
    const index = ids.indexOf(row.dataset.link) + (after ? 1 : 0);
    if (!ext && d.linkId === row.dataset.link && d.from === cid) return null;
    return {
      el: row,
      cls: after ? 'drop-after' : 'drop-before',
      copy,
      apply: (dt) => (ext ? dropExternal(dt, cid, index) : doMoveLink(d, cid, index, copy)),
    };
  }

  const hh = t.closest('.heading-header');
  if (hh) {
    const hid = hh.dataset.heading;
    const section = hh.parentElement;
    if (section.classList.contains('collapsed')) scheduleExpand(section, hid);
    if (d.kind === 'heading') {
      if (hid === d.id) return null;
      const entry = store.container(hid);
      const f = relY(e, hh);
      if (f < 0.3 || f > 0.7) {
        const parentId = entry.parent.id;
        if (store.canMoveHeading(d.id, parentId)) return null;
        const index = entry.parent.children.indexOf(entry.node) + (f > 0.7 ? 1 : 0);
        return f < 0.3
          ? { el: hh, cls: 'drop-before', apply: () => store.moveHeading(d.id, parentId, index) }
          : { el: section, cls: 'drop-after', apply: () => store.moveHeading(d.id, parentId, index) };
      }
      if (store.canMoveHeading(d.id, hid)) return null;
      return { el: hh, cls: 'drop-inside', apply: () => store.moveHeading(d.id, hid) };
    }
    return { el: hh, cls: 'drop-inside', copy, apply: (dt) => (ext ? dropExternal(dt, hid) : doMoveLink(d, hid, null, copy)) };
  }

  const body = t.closest('.container-body');
  if (body) {
    const cid = body.dataset.container;
    if (d.kind === 'heading') {
      if (store.canMoveHeading(d.id, cid)) return null;
      return { el: body, cls: 'drop-inside', apply: () => store.moveHeading(d.id, cid) };
    }
    return { el: body, cls: 'drop-inside', copy, apply: (dt) => (ext ? dropExternal(dt, cid) : doMoveLink(d, cid, null, copy)) };
  }
  return null;
}

function scheduleExpand(section, id) {
  if (expandEl === section) return;
  clearTimeout(expandTimer);
  expandEl = section;
  expandTimer = setTimeout(() => {
    section.classList.remove('collapsed');
    expandedDuringDrag.add(id);
  }, 650);
}

function readExternal(dt) {
  const moz = dt.getData('text/x-moz-url');
  if (moz) {
    const lines = moz.split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i += 2) if (lines[i]) out.push({ url: lines[i], name: lines[i + 1] || '' });
    if (out.length) return out;
  }
  const uris = (dt.getData('text/uri-list') || '').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  if (!uris.length) return extractUrls(dt.getData('text/plain'));
  let name = '';
  const html = dt.getData('text/html');
  if (html && uris.length === 1) {
    // DOMParser documents are inert: no scripts run, nothing loads
    const a = new DOMParser().parseFromString(html, 'text/html').querySelector('a[href]');
    name = (a?.textContent || '').replace(/\s+/g, ' ').trim();
    if (name === uris[0]) name = '';
  }
  return uris.map((url) => ({ url, name }));
}

function dropExternal(dt, containerId, index = null) {
  if (dt.files?.length) {
    importFiles(dt.files);
    return;
  }
  addUrls(readExternal(dt), containerId, index);
}

document.addEventListener('dragover', (e) => {
  lastDragOver = Date.now();
  const external = !drag && isExternal(e.dataTransfer);
  const d = drag || (external ? { kind: 'external' } : null);
  if (!d) return;
  const t = e.target instanceof Element ? e.target : null;
  if (external && t?.closest('input, textarea')) return; // let the field take it
  if (external) document.body.classList.add('is-dragging-external');
  const target = computeDrop(e, d);
  setIndicator(target);
  // always claim external drags so the browser never navigates away from the app
  if (target || external) e.preventDefault();
  if (target) e.dataTransfer.dropEffect = external || target.copy || d.from === null ? 'copy' : 'move';
  else if (external) e.dataTransfer.dropEffect = 'none';
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) {
    setIndicator(null);
    document.body.classList.remove('is-dragging-external');
  }
});
document.addEventListener('drop', (e) => {
  const external = !drag && isExternal(e.dataTransfer);
  const d = drag || (external ? { kind: 'external' } : null);
  if (!d) return;
  const t = e.target instanceof Element ? e.target : null;
  if (external && t?.closest('input, textarea')) return;
  e.preventDefault();
  const target = computeDrop(e, d);
  const dt = e.dataTransfer;
  endDrag();
  if (!target) return;
  try {
    target.apply(dt);
  } catch (err) {
    fail(err);
  }
});

// ---------- import files ----------

async function importFiles(files) {
  let lastCollection = null;
  const replace = $('#import-replace').checked;
  try {
    for (const file of files) {
      const text = await file.text();
      if (/\.json$/i.test(file.name) || text.trimStart().startsWith('{')) {
        store.importJSON(text, { mode: replace ? 'replace' : 'merge' });
      } else {
        lastCollection = store.importMarkdown(text, file.name.replace(/\.[^.]+$/, ''));
      }
    }
    $('#io-dialog').close();
    if (lastCollection) openCollection(lastCollection);
    toast(`Imported ${files.length} file${files.length === 1 ? '' : 's'}`, { action: [undoAction] });
  } catch (err) {
    fail(new Error(`Import failed: ${err.message}`));
  }
}
$('#import-file').addEventListener('change', (e) => {
  if (e.target.files.length) importFiles([...e.target.files]);
  e.target.value = '';
});

// ---------- bookmarklet & #add links ----------

function appUrl() {
  return location.href.replace(/#.*$/, '');
}
function bookmarkletCode() {
  const js = `(function(){var s=String(window.getSelection()||'').trim().slice(0,2000);window.open(${JSON.stringify(
    appUrl() + '#add?'
  )}+'url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)+(s?'&note='+encodeURIComponent(s):''),'linkshelf')})()`;
  return 'javascript:' + js;
}

function handleHash() {
  const m = location.hash.match(/^#add\?(.*)$/);
  if (!m) return;
  const p = new URLSearchParams(m[1]);
  history.replaceState(null, '', appUrl());
  const url = p.get('url') || '';
  if (!url) return;
  if (!store.state.collections.length) {
    store.addCollection('Inbox');
  }
  const existing = store.getLinkByUrl(url);
  openLinkDialog({
    url,
    name: existing?.name || p.get('title') || '',
    note: existing?.note || p.get('note') || '',
    containerId: ui.lastLocation && store.container(ui.lastLocation) ? ui.lastLocation : targetId(),
  });
}
window.addEventListener('hashchange', handleHash);

// ---------- sync between tabs ----------

window.addEventListener('storage', (e) => {
  if (e.key === store.key) store.reload();
});

// ---------- theme ----------

const THEME_KEY = 'linkshelf:theme';
const THEMES = {
  system: { label: 'match system', icon: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>' },
  light: { label: 'light', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' },
  dark: { label: 'dark', icon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>' },
};
function getTheme() {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : 'system';
}
function setTheme(t) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    if (t === 'system') storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, t);
  } catch {}
  renderThemeButton();
}
function renderThemeButton() {
  const t = getTheme();
  const next = { system: 'light', light: 'dark', dark: 'system' }[t];
  const btn = $('#theme-btn');
  btn.innerHTML = THEMES[t].icon;
  btn.title = `Theme: ${THEMES[t].label} (click for ${THEMES[next].label})`;
  btn.setAttribute('aria-label', btn.title);
}
renderThemeButton();
window.addEventListener('storage', (e) => {
  if (e.key !== THEME_KEY) return;
  if (e.newValue === 'light' || e.newValue === 'dark') document.documentElement.dataset.theme = e.newValue;
  else delete document.documentElement.dataset.theme;
  renderThemeButton();
});

// ---------- sample data ----------

const SAMPLE = `<!-- collection: My App -->

- [Product brief](<https://example.com/docs/brief>)
  The one-pager. Start here when onboarding someone.

# Deployments

- [Production](<https://app.example.com>)
  Customer-facing. Deploys from main after CI passes.
- [Staging](<https://staging.example.com>)
  Reset nightly at 02:00 UTC.

## Pipelines

- [CI dashboard](<https://github.com/features/actions>)

### Release checklist

- [Changelog conventions](<https://keepachangelog.com>)

# Monitoring

- [Status page](<https://www.githubstatus.com>)
- [Error tracking](<https://example.com/errors>)

# Reference

## Web platform

- [MDN Web Docs](<https://developer.mozilla.org>)
  Best reference for HTML, CSS and JS APIs.
- [Can I use](<https://caniuse.com>)
`;

// ---------- go ----------

if (store.state.collections.length && ui.view.type === 'library' && !storage?.getItem(UI_KEY)) {
  ui.view = { type: 'collection', id: store.state.collections[0].id };
}
render();
handleHash();
if (!storage) toast('Local storage is blocked in this browser, so nothing will be saved.', { error: true, timeout: 15000 });
navigator.storage?.persist?.().catch(() => {});
