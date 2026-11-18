import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Store,
  normalizeUrl,
  nameFromUrl,
  MAX_DEPTH,
  parseMarkdown,
  findRefs,
} from '../js/store.js';

class MemStorage {
  constructor() {
    this.m = new Map();
  }
  getItem(k) {
    return this.m.has(k) ? this.m.get(k) : null;
  }
  setItem(k, v) {
    this.m.set(k, String(v));
  }
}

const fresh = () => new Store({ storage: new MemStorage() });

test('normalizeUrl', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('  https://Example.com/a?b=1#c '), 'https://example.com/a?b=1#c');
  assert.equal(normalizeUrl('localhost:3000/x'), 'http://localhost:3000/x');
  assert.equal(normalizeUrl('192.168.1.10:8080'), 'https://192.168.1.10:8080/');
  assert.equal(normalizeUrl('mailto:a@b.co'), 'mailto:a@b.co');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('hello world'), null);
  assert.equal(normalizeUrl('e.g'), null);
  assert.equal(normalizeUrl(''), null);
});

test('nameFromUrl', () => {
  assert.equal(nameFromUrl('https://www.github.com/matt/repo/'), 'github.com/matt/repo');
});

test('links are unique by URL and referenced by id', () => {
  const s = fresh();
  const c = s.addCollection('My App');
  const a = s.saveLink({ url: 'https://x.dev' }, { containerId: c });
  const b = s.saveLink({ url: 'x.dev', name: 'X' }, { containerId: c });
  assert.equal(a.link.id, b.link.id);
  assert.ok(a.created && !b.created);
  assert.equal(Object.keys(s.state.links).length, 1);
  assert.equal(s.getLink(a.link.id).name, 'X');
  assert.deepEqual(s.getCollection(c).links, [a.link.id]); // not duplicated in the same container
});

test('same link in many places; edit once updates everywhere; delete removes all refs', () => {
  const s = fresh();
  const c1 = s.addCollection('A');
  const c2 = s.addCollection('B');
  const h = s.addHeading(c2, 'Deployments');
  const { link } = s.saveLink({ url: 'https://ci.example.com' }, { containerId: c1 });
  s.moveLink(link.id, null, h);
  assert.equal(findRefs(s.state, link.id).length, 2);
  s.updateLink(link.id, { name: 'CI', note: 'build server' });
  assert.equal(s.getLink(link.id).note, 'build server');
  s.deleteLink(link.id);
  assert.equal(s.getCollection(c1).links.length, 0);
  assert.equal(s.container(h).node.links.length, 0);
});

test('headings nest up to MAX_DEPTH levels', () => {
  const s = fresh();
  let parent = s.addCollection('Deep');
  for (let i = 1; i <= MAX_DEPTH; i++) parent = s.addHeading(parent, `H${i}`);
  assert.equal(s.container(parent).depth, MAX_DEPTH);
  assert.throws(() => s.addHeading(parent, 'too deep'));
});

test('moveHeading prevents cycles and over-deep nesting, supports cross-collection', () => {
  const s = fresh();
  const c = s.addCollection('C');
  const a = s.addHeading(c, 'A');
  const b = s.addHeading(a, 'B');
  assert.throws(() => s.moveHeading(a, b));
  assert.throws(() => s.moveHeading(a, a));
  // build a 5-deep chain, then try to put A (height 2) at the bottom
  let p = s.addHeading(c, 'L1');
  for (let i = 2; i <= 5; i++) p = s.addHeading(p, `L${i}`);
  assert.ok(s.canMoveHeading(a, p)); // 5 + 2 > 6
  const other = s.addCollection('Other');
  s.moveHeading(a, other);
  assert.equal(s.getCollection(other).children[0].id, a);
  assert.equal(s.getCollection(c).children.length, 1);
});

test('reordering within a container', () => {
  const s = fresh();
  const c = s.addCollection('C');
  const ids = ['a.com', 'b.com', 'c.com'].map((u) => s.saveLink({ url: u }, { containerId: c }).link.id);
  s.moveLink(ids[0], c, c, 3); // move first to end
  assert.deepEqual(s.getCollection(c).links, [ids[1], ids[2], ids[0]]);
  s.moveLink(ids[0], c, c, 0);
  assert.deepEqual(s.getCollection(c).links, ids);
  const h1 = s.addHeading(c, 'one');
  const h2 = s.addHeading(c, 'two');
  s.moveHeading(h2, c, 0);
  assert.deepEqual(s.getCollection(c).children.map((h) => h.id), [h2, h1]);
});

test('changing a URL to an existing one merges records', () => {
  const s = fresh();
  const c = s.addCollection('C');
  const h = s.addHeading(c, 'H');
  const a = s.saveLink({ url: 'a.com' }, { containerId: c }).link.id;
  const b = s.saveLink({ url: 'b.com' }, { containerId: h }).link.id;
  s.moveLink(a, null, h);
  s.updateLink(b, { url: 'a.com' });
  assert.equal(Object.keys(s.state.links).length, 1);
  assert.deepEqual(s.container(h).node.links, [a]);
});

test('deleteHeading with and without keeping contents', () => {
  const s = fresh();
  const c = s.addCollection('C');
  const h = s.addHeading(c, 'H');
  const sub = s.addHeading(h, 'Sub');
  const l = s.saveLink({ url: 'a.com' }, { containerId: h }).link.id;
  s.deleteHeading(h, { keepContents: true });
  assert.deepEqual(s.getCollection(c).links, [l]);
  assert.equal(s.getCollection(c).children[0].id, sub);
  s.deleteHeading(sub);
  assert.equal(s.getCollection(c).children.length, 0);
  assert.ok(s.getLink(l)); // links stay in the library
});

test('undo / redo and persistence', () => {
  const storage = new MemStorage();
  const s = new Store({ storage });
  const c = s.addCollection('C');
  s.renameCollection(c, 'Renamed');
  s.undo();
  assert.equal(s.getCollection(c).name, 'C');
  s.redo();
  assert.equal(s.getCollection(c).name, 'Renamed');
  const s2 = new Store({ storage });
  assert.equal(s2.getCollection(c).name, 'Renamed');
});

test('failed mutation rolls back', () => {
  const s = fresh();
  const c = s.addCollection('C');
  assert.throws(() => s.saveLink({ url: 'not a url' }, { containerId: c }));
  assert.throws(() => s.saveLink({ url: 'a.com' }, { containerId: 'missing' }));
  assert.equal(Object.keys(s.state.links).length, 0);
});

test('markdown round trip', () => {
  const s = fresh();
  const c = s.addCollection('My App');
  s.saveLink({ url: 'https://app.example.com', name: 'Prod [main]', note: 'line one\nline two' }, { containerId: c });
  const d = s.addHeading(c, 'Deployments');
  s.saveLink({ url: 'https://staging.example.com', name: 'Staging' }, { containerId: d });
  const deep = s.addHeading(s.addHeading(d, 'AWS'), 'Lambdas');
  s.saveLink({ url: 'https://console.aws.amazon.com/lambda', name: 'Lambda console' }, { containerId: deep });
  const md = s.exportMarkdown(c);
  assert.match(md, /^### Lambdas$/m);

  const t = fresh();
  const id = t.importMarkdown(md);
  const col = t.getCollection(id);
  assert.equal(col.name, 'My App');
  assert.equal(t.getLink(col.links[0]).name, 'Prod [main]');
  assert.equal(t.getLink(col.links[0]).note, 'line one\nline two');
  assert.equal(col.children[0].title, 'Deployments');
  assert.equal(col.children[0].children[0].children[0].title, 'Lambdas');
  assert.equal(t.exportMarkdown(id), md);
});

test('parseMarkdown handles bare urls, inline notes and skipped levels', () => {
  const { root } = parseMarkdown('# A\n- https://a.com\n### Deep\n- [B](https://b.com) — the b site\nhttps://c.com\n');
  assert.equal(root.children[0].items[0].url, 'https://a.com');
  assert.equal(root.children[0].children[0].title, 'Deep');
  assert.equal(root.children[0].children[0].items[0].note, 'the b site');
  assert.equal(root.children[0].children[0].items.length, 2);
});

test('JSON import merge dedupes by URL', () => {
  const s = fresh();
  const c = s.addCollection('C');
  s.saveLink({ url: 'a.com' }, { containerId: c });
  const dump = s.exportJSON();
  s.importJSON(dump, { mode: 'merge' });
  assert.equal(s.state.collections.length, 2);
  assert.equal(Object.keys(s.state.links).length, 1);
  assert.equal(s.state.collections[1].links[0], s.state.collections[0].links[0]);
  s.importJSON(dump, { mode: 'replace' });
  assert.equal(s.state.collections.length, 1);
});

test('search ranks name matches and requires all terms', () => {
  const s = fresh();
  const c = s.addCollection('C');
  s.saveLink({ url: 'a.com', name: 'Deploy dashboard' }, { containerId: c });
  s.saveLink({ url: 'b.com', name: 'Docs', note: 'how to deploy' }, { containerId: c });
  assert.deepEqual(s.search('deploy').map((l) => l.name), ['Deploy dashboard', 'Docs']);
  assert.deepEqual(s.search('deploy how').map((l) => l.name), ['Docs']);
});

test('nested mutations form one undo step and roll back together', () => {
  const s = fresh();
  const c = s.addCollection('C');
  s.mutate(() => {
    s.saveLink({ url: 'a.com' }, { containerId: c });
    s.saveLink({ url: 'b.com' }, { containerId: c });
  });
  assert.equal(s.getCollection(c).links.length, 2);
  s.undo();
  assert.equal(s.getCollection(c).links.length, 0);
  assert.throws(() =>
    s.mutate(() => {
      s.saveLink({ url: 'a.com' }, { containerId: c });
      s.saveLink({ url: 'nope nope' }, { containerId: c });
    })
  );
  assert.equal(Object.keys(s.state.links).length, 0);
});

test('heading notes: update, clear, persist, markdown round trip', () => {
  const s = fresh();
  const c = s.addCollection('C');
  const h = s.addHeading(c, 'Deployments');
  s.updateHeading(h, { note: 'Deploys go out Tuesdays.\n- not a list item\nhttps://not-a-link.example\n# not a heading' });
  const sub = s.addHeading(h, 'Sub');
  s.saveLink({ url: 'a.com', name: 'A' }, { containerId: h });
  assert.match(s.container(h).node.note, /^Deploys/);

  const md = s.exportMarkdown(c);
  const t = fresh();
  const id = t.importMarkdown(md);
  const h2 = t.getCollection(id).children[0];
  assert.equal(h2.note, s.container(h).node.note);
  assert.equal(h2.links.length, 1);
  assert.equal(h2.children[0].title, 'Sub');
  assert.equal(t.exportMarkdown(id), md);

  // survives a JSON round trip
  const u = fresh();
  u.importJSON(s.exportJSON(), { mode: 'replace' });
  assert.equal(u.state.collections[0].children[0].note, s.container(h).node.note);

  s.updateHeading(h, { title: 'Deploys', note: '  ' });
  assert.equal(s.container(h).node.title, 'Deploys');
  assert.equal('note' in s.container(h).node, false);
  assert.ok(s.container(sub));
});

test('setCollapsedDeep collapses/expands everything below a container', async () => {
  const { hasExpandedDescendant } = await import('../js/store.js');
  const s = fresh();
  const c = s.addCollection('C');
  const a = s.addHeading(c, 'A');
  const a1 = s.addHeading(a, 'A1');
  const a11 = s.addHeading(a1, 'A11');
  const b = s.addHeading(c, 'B');
  const undoDepth = s.undoStack.length;

  s.setCollapsedDeep(a, true, { self: false });
  assert.equal(!!s.container(a).node.collapsed, false);
  assert.equal(s.container(a1).node.collapsed, true);
  assert.equal(s.container(a11).node.collapsed, true);
  assert.equal(!!s.container(b).node.collapsed, false);
  assert.equal(hasExpandedDescendant(s.container(a).node), false);
  assert.equal(hasExpandedDescendant(s.getCollection(c)), true);

  s.setCollapsedDeep(c, true);
  assert.ok([a, a1, a11, b].every((id) => s.container(id).node.collapsed));
  s.setCollapsedDeep(c, false);
  assert.ok([a, a1, a11, b].every((id) => !s.container(id).node.collapsed));
  assert.equal(s.undoStack.length, undoDepth); // view state, not undoable
});

test('collection slugs: readable, unique, forgiving lookup', async () => {
  const { slugify, collectionSlugs, findCollectionBySlug } = await import('../js/store.js');
  assert.equal(slugify('My App!'), 'my-app');
  assert.equal(slugify('Café  Déjà vu'), 'cafe-deja-vu');
  assert.equal(slugify('***'), 'collection');
  const s = fresh();
  const a = s.addCollection('My App');
  const b = s.addCollection('My app');
  const all = s.addCollection('All');
  const slugs = collectionSlugs(s.state);
  assert.equal(slugs.get(a), 'my-app');
  assert.equal(slugs.get(b), 'my-app-2');
  assert.equal(slugs.get(all), 'all-2'); // "all" is reserved for the library view
  assert.equal(findCollectionBySlug(s.state, 'my_app').id, a);
  assert.equal(findCollectionBySlug(s.state, 'My App').id, a);
  assert.equal(findCollectionBySlug(s.state, 'my-app-2').id, b);
  assert.equal(findCollectionBySlug(s.state, b).id, b); // ids work too
  assert.equal(findCollectionBySlug(s.state, 'nope'), null);
});
