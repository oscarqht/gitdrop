import { describe, expect, it } from 'vitest';
import { applyOperation, createLibrary, makeItem } from '../src/domain/operations';
import { mergeLibraries, mergeNotes } from '../src/domain/merge';
import { orderBetween } from '../src/domain/order';
import { validateLibrary, type Library, type Item } from '../src/domain/types';
import { searchBookmarks } from '../src/domain/search';
function create(l: Library, item: Item) { return applyOperation(l, { id: `create-${item.id}`, actor: 'initial', type: 'create', record: item }); }
function update(l: Library, id: string, patch: Partial<Item>, actor: string) { return applyOperation(l, { id: `${actor}-${JSON.stringify(patch)}`, actor, type: 'update', recordId: id, patch }); }
function fixture() { return create(createLibrary(), makeItem('bookmark', {id:'bookmark',title:'Original',url:'https://example.com',tags:['old'],note:'one\ntwo\nthree'})); }
describe('semantic reconciliation', () => {
  it('combines independent fields and converges regardless of client orientation', () => {
    const base = fixture(); const a = update(base,'bookmark',{title:'Changed'},'a'); const b = update(base,'bookmark',{description:'Description'},'b');
    const merged = mergeLibraries(base,a,b); expect(merged.records.bookmark.title).toBe('Changed'); expect(merged.records.bookmark.description).toBe('Description');
    expect(merged).toEqual(mergeLibraries(base,b,a)); expect(mergeLibraries(merged,merged,merged)).toEqual(merged);
  });
  it('keeps displaced scalar values recoverable with stable IDs', () => {
    const base = fixture(); const a = update(base,'bookmark',{title:'A'},'a'); const b = update(base,'bookmark',{title:'B'},'b');
    const result = mergeLibraries(base,a,b); expect(result.records.bookmark.title).toBe('B'); expect(Object.values(result.recovery)[0].record.title).toBe('A'); expect(result).toEqual(mergeLibraries(base,b,a));
  });
  it('combines tag additions while honoring removals', () => { const base = fixture(); const result = mergeLibraries(base,update(base,'bookmark',{tags:['a']},'a'),update(base,'bookmark',{tags:['old','b']},'b')); expect(result.records.bookmark.tags).toEqual(['a','b']); });
  it('merges nonoverlapping note changes and preserves conflicting versions', () => {
    expect(mergeNotes('one\ntwo\nthree','ONE\ntwo\nthree','one\ntwo\nTHREE')).toBe('ONE\ntwo\nTHREE');
    expect(mergeNotes('one','ONE','uno')).toBeNull();
  });
  it('deletion wins concurrent edits even with a higher revision counter', () => {
    const base = fixture(); const a = applyOperation(base,{id:'delete',actor:'a',type:'delete',recordId:'bookmark'});
    let b = update(base,'bookmark',{title:'Edited'},'b'); b = update(b,'bookmark',{note:'Changed'},'b');
    const result = mergeLibraries(base,a,b); expect(result.records.bookmark).toBeUndefined(); expect(Object.values(result.recovery).some(r=>r.record.title==='Edited')).toBe(true);
    expect(result).toEqual(mergeLibraries(base,b,a));
  });
  it('purge preserves deletion protection and explicit restoration propagates', () => {
    const base = fixture(); const deleted = applyOperation(base,{id:'delete',actor:'a',type:'delete',recordId:'bookmark'});
    const restored = applyOperation(deleted,{id:'restore',actor:'a',type:'restore',recordId:'bookmark'});
    expect(mergeLibraries(deleted,restored,deleted).records.bookmark).toBeDefined();
    const purged = applyOperation(deleted,{id:'purge',actor:'a',type:'purge',recordId:'bookmark'});
    const result = mergeLibraries(deleted,purged,deleted); expect(result.tombstones.bookmark.record).toBeUndefined(); expect(result.records.bookmark).toBeUndefined();
  });
  it('rescues a concurrent addition under a deleted collection', () => {
    const base = create(createLibrary(),makeItem('collection',{id:'folder',title:'Folder'}));
    const deleted = applyOperation(base,{id:'delete',actor:'a',type:'delete',recordId:'folder'});
    const added = create(base,makeItem('bookmark',{id:'bookmark',title:'New',url:'https://example.com',parentId:'folder'}));
    const result = mergeLibraries(base,deleted,added); expect(result.records.bookmark.parentId).toBe('gitdrop-recovered'); expect(result.records['gitdrop-recovered'].kind).toBe('collection');
  });
  it('repairs cycles caused by concurrent valid moves deterministically', () => {
    let base = createLibrary(); for (const id of ['a','b']) base=create(base,makeItem('collection',{id,title:id}));
    const left=update(base,'a',{parentId:'b'},'left'); const right=update(base,'b',{parentId:'a'},'right'); const result=mergeLibraries(base,left,right);
    expect(result.records.a.parentId).toBeNull(); expect(result).toEqual(mergeLibraries(base,right,left));
  });
  it('does not resurrect cleared recovery entries', () => {
    const start=fixture(); const base=mergeLibraries(start,update(start,'bookmark',{title:'A'},'a'),update(start,'bookmark',{title:'B'},'b'));
    const cleared=applyOperation(base,{id:'clear',actor:'a',type:'clearRecovery'}); expect(mergeLibraries(base,cleared,base).recovery).toEqual({});
  });
});
describe('operations and boundaries', () => {
  it('deduplicates replayed operations and protects immutable identity', () => {
    const base=fixture(); const op={id:'change',actor:'a',type:'update' as const,recordId:'bookmark',patch:{id:'evil',title:'New'}};
    const result=applyOperation(base,op); expect(applyOperation(result,op)).toBe(result); expect(result.records.bookmark.id).toBe('bookmark');
  });
  it('rejects invalid bookmark URLs and missing parents', () => {
    expect(()=>makeItem('bookmark',{title:'bad',url:'javascript:alert(1)'})).toThrow();
    expect(()=>create(createLibrary(),makeItem('collection',{title:'bad',parentId:'missing'}))).toThrow();
  });
  it('allows complete emoji sequences and rejects path traversal images', () => {
    expect(()=>makeItem('collection',{title:'Flag',cover:{mode:'emoji',emoji:'🇸🇬'}})).not.toThrow();
    expect(()=>makeItem('collection',{title:'Bad',cover:{mode:'image',imageFile:'../secret'}})).toThrow();
    expect(validateLibrary(fixture()).schemaVersion).toBe(1);
  });
  it('can insert repeatedly at the top without rewriting other records', () => {
    let rank=orderBetween(); for(let i=0;i<1000;i++){const next=orderBetween(null,rank); expect(next<rank).toBe(true); rank=next;}
  });
  it('searches notes with tag filters',()=>{ const base=fixture(); expect(searchBookmarks(base,{query:'two',tags:['old']})).toHaveLength(1); expect(searchBookmarks(base,{query:'two',tags:['missing']})).toHaveLength(0); });
});

describe('named URL variants', () => {
  it('creates Default without copying the shared title into variant names', () => {
    const item = makeItem('bookmark', { title: 'Documentation', url: 'https://example.com' });
    expect(item.variants?.[0].name).toBe('Default'); expect(item.defaultVariantId).toBe(item.variants?.[0].id);
  });
  it('keeps default selection independent of reordering and shared title', () => {
    const base = fixture(), original = base.records.bookmark;
    const extra = {id:'mirror',name:'Mirror',url:'https://mirror.example.com',order:orderBetween(null,original.variants![0].order)};
    const result = update(base,'bookmark',{variants:[...original.variants!,extra],defaultVariantId:'mirror'},'a');
    expect(result.records.bookmark.title).toBe('Original'); expect(result.records.bookmark.variants?.[0].name).toBe('Default');
    expect(result.records.bookmark.defaultVariantId).toBe('mirror');
  });
  it('merges independent name and URL edits on the same variant', () => {
    const base = fixture(), variants=base.records.bookmark.variants!;
    const a=update(base,'bookmark',{variants:variants.map(v=>({...v,name:'Production'}))},'a');
    const b=update(base,'bookmark',{variants:variants.map(v=>({...v,url:'https://new.example.com'}))},'b');
    const merged=mergeLibraries(base,a,b); expect(merged.records.bookmark.variants?.[0]).toMatchObject({name:'Production',url:'https://new.example.com'});
    expect(merged).toEqual(mergeLibraries(base,b,a)); expect(Object.keys(merged.recovery)).toHaveLength(0);
  });
  it('retains independent additions and resolves conflicting names recoverably', () => {
    const base=fixture(), variants=base.records.bookmark.variants!;
    const a=update(base,'bookmark',{variants:[{...variants[0],name:'A'},{id:'a',name:'Staging',url:'https://a.example.com',order:orderBetween(variants[0].order)}]},'a');
    const b=update(base,'bookmark',{variants:[{...variants[0],name:'B'},{id:'b',name:'Mirror',url:'https://b.example.com',order:orderBetween(variants[0].order)}]},'b');
    const merged=mergeLibraries(base,a,b); expect(merged.records.bookmark.variants).toHaveLength(3); expect(Object.values(merged.recovery).some(r=>r.reason.includes('name'))).toBe(true); expect(merged).toEqual(mergeLibraries(base,b,a));
  });
  it('never leaves zero variants after concurrent removals', () => {
    let base=fixture(); const one=base.records.bookmark.variants![0], two={id:'two',name:'Two',url:'https://two.example.com',order:orderBetween(one.order)};
    base=update(base,'bookmark',{variants:[one,two]},'init');
    const a=update(base,'bookmark',{variants:[one]},'a'); const b=update(base,'bookmark',{variants:[two],defaultVariantId:two.id},'b');
    const merged=mergeLibraries(base,a,b); expect(merged.records.bookmark.variants).toHaveLength(1); expect(()=>validateLibrary(merged)).not.toThrow(); expect(merged).toEqual(mergeLibraries(base,b,a));
  });
  it('requires a name, valid order, unique identity, and an existing default', () => {
    const item=fixture().records.bookmark, first=item.variants![0];
    for(const patch of [{variants:[]},{variants:[{...first,name:''}]},{variants:[first,first]},{variants:[{...first,order:'!invalid'}]},{defaultVariantId:'missing'}]) expect(()=>makeItem('bookmark',{...item,...patch})).toThrow();
    expect(()=>makeItem('collection',{id:'__proto__',title:'Bad'})).toThrow();
  });
  it('searches all variant names and URLs', () => {
    const base=fixture(), variants=base.records.bookmark.variants!;
    const result=update(base,'bookmark',{variants:[...variants,{id:'mirror',name:'Staging',url:'https://mirror.example.com',order:orderBetween(variants[0].order)}]},'a');
    expect(searchBookmarks(result,{query:'staging'})).toHaveLength(1); expect(searchBookmarks(result,{query:'mirror.example.com'})).toHaveLength(1);
  });
});

describe('collection trash and recovery',()=>{
  it('rescues concurrent edits of children when the collection is deleted',()=>{
    let base=create(createLibrary(),makeItem('collection',{id:'folder',title:'Folder'}));
    base=create(base,makeItem('bookmark',{id:'child',title:'Child',url:'https://example.com',parentId:'folder'}));
    const removed=applyOperation(base,{id:'del-folder',actor:'a',type:'delete',recordId:'folder'});
    const edited=update(base,'child',{note:'Keep my work'},'b');
    const merged=mergeLibraries(base,removed,edited);
    expect(merged.records.child.note).toBe('Keep my work'); expect(merged.records.child.parentId).toBe('gitdrop-recovered');
    expect(merged).toEqual(mergeLibraries(base,edited,removed)); expect(mergeLibraries(merged,merged,merged)).toEqual(merged);
  });
  it('does not let a stale client revive a purged bookmark',()=>{
    const base=fixture(); const deleted=applyOperation(base,{id:'del',actor:'a',type:'delete',recordId:'bookmark'});
    const purged=applyOperation(deleted,{id:'purge',actor:'a',type:'purge',recordId:'bookmark'});
    const stale=update(base,'bookmark',{title:'Offline'},'b'); const merged=mergeLibraries(base,purged,stale);
    expect(merged.records.bookmark).toBeUndefined(); expect(merged.tombstones.bookmark.record).toBeUndefined();
  });
});

it('restores a trashed collection together with its unpurged descendants',()=>{
  let base=create(createLibrary(),makeItem('collection',{id:'folder',title:'Folder'}));
  base=create(base,makeItem('bookmark',{id:'child',title:'Child',url:'https://example.com',parentId:'folder'}));
  const deleted=applyOperation(base,{id:'delete-tree',actor:'a',type:'delete',recordId:'folder'});
  const restored=applyOperation(deleted,{id:'restore-tree',actor:'a',type:'restore',recordId:'folder'});
  expect(restored.records.child.parentId).toBe('folder'); expect(restored.records.folder).toBeDefined();
  expect(mergeLibraries(deleted,restored,deleted).records.child.parentId).toBe('folder');
});

describe('stale replicas and three clients',()=>{
  it('preserves purge markers even when the merge base predates deletion',()=>{
    const base=fixture(); const deleted=applyOperation(base,{id:'deleted',actor:'a',type:'delete',recordId:'bookmark'});
    const purged=applyOperation(deleted,{id:'purged',actor:'b',type:'purge',recordId:'bookmark'});
    const merged=mergeLibraries(base,purged,deleted); expect(merged.tombstones.bookmark.record).toBeUndefined();
    expect(merged).toEqual(mergeLibraries(base,deleted,purged));
  });
  it('does not revive cleared recovery through a stale common ancestor or repeated conflict',()=>{
    const base=fixture(), a=update(base,'bookmark',{title:'A'},'a'), b=update(base,'bookmark',{title:'B'},'b');
    const conflicted=mergeLibraries(base,a,b); const cleared=applyOperation(conflicted,{id:'clear',actor:'c',type:'clearRecovery'});
    expect(mergeLibraries(base,cleared,conflicted).recovery).toEqual({});
    expect(mergeLibraries(base,cleared,a).recovery).toEqual({});
  });
  it('converges for every delivery order of three independently edited fields',()=>{
    const base=fixture(), clients=[update(base,'bookmark',{title:'Title'},'a'),update(base,'bookmark',{description:'Description'},'b'),update(base,'bookmark',{note:'Note'},'c')];
    let expected:Library|undefined;
    for(const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]){
      const merged=mergeLibraries(base,mergeLibraries(base,clients[order[0]],clients[order[1]]),clients[order[2]]);
      expect(merged.records.bookmark).toMatchObject({title:'Title',description:'Description',note:'Note'});
      expected??=merged;expect(merged).toEqual(expected);
    }
  });
  it('merges three scalar conflicts without losing either displaced title',()=>{
    const base=fixture(), a=update(base,'bookmark',{title:'A'},'a'),b=update(base,'bookmark',{title:'B'},'b'),c=update(base,'bookmark',{title:'C'},'c');
    for(const clients of [[a,b,c],[c,a,b],[b,c,a]]){
      const merged=mergeLibraries(base,mergeLibraries(base,clients[0],clients[1]),clients[2]);
      expect(merged.records.bookmark.title).toBe('C'); expect(new Set(Object.values(merged.recovery).map(r=>r.record.title))).toEqual(new Set(['A','B']));
    }
  });
});

it('keeps URL ordering, naming, and default changes independent across clients',()=>{
  let base=fixture(); const one=base.records.bookmark.variants![0],two={id:'second',name:'Staging',url:'https://staging.example.com',order:orderBetween(one.order)};
  base=update(base,'bookmark',{variants:[one,two]},'initial-variants');
  const moved=update(base,'bookmark',{variants:[one,{...two,order:orderBetween(null,one.order)}]},'a');
  const named=update(base,'bookmark',{variants:[one,{...two,name:'Preview'}],defaultVariantId:two.id},'b');
  const result=mergeLibraries(base,moved,named).records.bookmark;
  expect(result.title).toBe('Original');expect(result.defaultVariantId).toBe('second');
  expect(result.variants?.find(v=>v.id==='second')).toMatchObject({name:'Preview',order:orderBetween(null,one.order)});
});

it('merges disjoint multi-hunk notes and deduplicates identical hunks',()=>{
  const base='one\ntwo\nthree\nfour\nfive';
  expect(mergeNotes(base,'ONE\ntwo\nthree\nfour\nFIVE','one\ntwo\nTHREE\nfour\nfive')).toBe('ONE\ntwo\nTHREE\nfour\nFIVE');
  expect(mergeNotes(base,'ONE\ntwo\nthree\nfour\nFIVE','ONE\ntwo\nTHREE\nfour\nfive')).toBe('ONE\ntwo\nTHREE\nfour\nFIVE');
  expect(mergeNotes(base,'one\ninsert\ntwo\nthree\nfour\nfive','one\ntwo\nthree\nfour\nFIVE')).toBe('one\ninsert\ntwo\nthree\nfour\nFIVE');
  expect(mergeNotes(base,'one\ninsert\ntwo\nthree\nfour\nfive','one\nother\ntwo\nthree\nfour\nfive')).toBeNull();
});

it('retains variant deletion through three-client repeated merges and recovers conflicting edits',()=>{
  let base=fixture(); const first=base.records.bookmark.variants![0], second={id:'alternate',name:'Alternate',url:'https://alternate.example.com',order:orderBetween(first.order)};
  base=update(base,'bookmark',{variants:[first,second]},'init');
  const removed=update(base,'bookmark',{variants:[first]},'a');
  const renamed=update(base,'bookmark',{variants:[first,{...second,name:'Offline name'}]},'b');
  const changedURL=update(base,'bookmark',{variants:[first,{...second,url:'https://changed.example.com'}]},'c');
  for(const order of [[removed,renamed,changedURL],[renamed,changedURL,removed],[changedURL,removed,renamed]]){
    let merged=mergeLibraries(base,mergeLibraries(base,order[0],order[1]),order[2]);
    expect(merged.records.bookmark.variants).toEqual([first]);
    expect(Object.values(merged.recovery).some(r=>r.record.variants?.some(v=>v.name==='Offline name'))).toBe(true);
    expect(Object.values(merged.recovery).some(r=>r.record.variants?.some(v=>v.url==='https://changed.example.com'))).toBe(true);
    merged=mergeLibraries(base,merged,renamed);expect(merged.records.bookmark.variants).toEqual([first]);
    expect(()=>validateLibrary(merged)).not.toThrow();
  }
});

describe('automatic metadata provenance',()=>{
  it('stamps the actual field revision and preserves user overrides including same-value edits',()=>{
    const base=fixture(); expect(base.records.bookmark.metadata).toBeUndefined();
    const auto=update(base,'bookmark',{title:'Fetched',description:'Fetched description'},'metadata');
    const item=auto.records.bookmark;
    expect(item.metadata?.title).toEqual({value:'Fetched',revision:item.fieldRevisions?.title});
    expect(item.metadata?.description).toEqual({value:'Fetched description',revision:item.fieldRevisions?.description});
    const manual=update(auto,'bookmark',{title:'Fetched'},'user').records.bookmark;
    expect(manual.metadata?.title?.revision).not.toEqual(manual.fieldRevisions?.title);
    expect(manual.metadata?.title?.value).toBe(manual.title);
    const refreshed=update(auto,'bookmark',{title:'Refreshed'},'metadata').records.bookmark;
    expect(refreshed.metadata?.title).toEqual({value:'Refreshed',revision:refreshed.fieldRevisions?.title});
  });
  it('keeps provenance attached to the selected field through independent concurrent edits',()=>{
    const base=fixture(), automatic=update(base,'bookmark',{title:'Fetched'},'metadata'), manual=update(base,'bookmark',{description:'Manual'},'user');
    const merged=mergeLibraries(base,automatic,manual);
    expect(merged.records.bookmark.metadata?.title).toEqual({value:'Fetched',revision:merged.records.bookmark.fieldRevisions?.title});
    expect(merged.records.bookmark.description).toBe('Manual');expect(merged).toEqual(mergeLibraries(base,manual,automatic));
  });
});

describe('raindrop csv import and batch create', () => {
  it('parses Raindrop CSV rows with quoted fields, tags, notes, excerpts, and applies batch create into target collection', async () => {
    const { parseRaindropCsv } = await import('../src/domain/csv');
    const csv = [
      'id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite',
      '1039405875,"The ""Wait, Not Like That"" Free Speech Panic",A note,"In February, 2021, an article",https://www.techdirt.com/2025/04/17/free-speech/,Unsorted,"politics, media, politics",2025-04-17T23:54:51.630Z,https://img.example.com/1.png,,false',
      '1075498448,AI Is Polytheistic,,"Emergent ""Gods""\nMultiline excerpt",https://www.noemamag.com/ai-is-polytheistic/,Unsorted,ai,2025-05-06T03:06:16.597Z,,Some highlight,true',
    ].join('\r\n');

    const col = makeItem('collection', { id: 'col-reading', title: 'Reading' });
    const existing = makeItem('bookmark', {
      id: 'bm-existing',
      title: 'Existing',
      url: 'https://existing.example.com',
      parentId: col.id,
      order: 'a5',
    });
    let library = create(createLibrary(), col);
    library = create(library, existing);

    const items = parseRaindropCsv(csv, {
      parentId: col.id,
      beforeOrder: existing.order,
      actor: 'importer',
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: 'bookmark',
      title: 'The "Wait, Not Like That" Free Speech Panic',
      note: 'A note',
      description: 'In February, 2021, an article',
      parentId: 'col-reading',
      tags: ['politics', 'media'],
      createdAt: '2025-04-17T23:54:51.630Z',
    });
    expect(items[0].variants?.[0].url).toBe('https://www.techdirt.com/2025/04/17/free-speech/');
    expect(items[1]).toMatchObject({
      kind: 'bookmark',
      title: 'AI Is Polytheistic',
      note: 'Some highlight',
      description: 'Emergent "Gods"\nMultiline excerpt',
      parentId: 'col-reading',
      tags: ['ai'],
      createdAt: '2025-05-06T03:06:16.597Z',
    });
    expect(items[0].order < items[1].order).toBe(true);
    expect(items[1].order < existing.order).toBe(true);

    const updated = applyOperation(library, {
      id: 'batch-import-op',
      actor: 'importer',
      type: 'create',
      records: items,
    });
    expect(Object.keys(updated.records)).toHaveLength(4);
    expect(updated.records[items[0].id].parentId).toBe('col-reading');
    expect(updated.records[items[1].id].parentId).toBe('col-reading');
  });

  it('handles UTF-8 BOM, combined note+highlights, fallback hostname titles, and rejects invalid CSVs', async () => {
    const { parseRaindropCsv } = await import('../src/domain/csv');
    const csvWithBom =
      '\uFEFFid,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite\n' +
      '1,,User note,Short excerpt,example.com/article,OtherFolder,"tag1, tag2",invalid-date,,Highlighted text,false\n' +
      '2,Ignored Javascript,,,javascript:alert(1),OtherFolder,,,,,\n';

    const items = parseRaindropCsv(csvWithBom, { parentId: 'col-target' });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('example.com');
    expect(items[0].note).toBe('User note\n\nHighlighted text');
    expect(items[0].description).toBe('Short excerpt');
    expect(items[0].tags).toEqual(['tag1', 'tag2']);
    expect(items[0].parentId).toBe('col-target');
    expect(items[0].variants?.[0].url).toBe('https://example.com/article');

    expect(() => parseRaindropCsv('')).toThrow('No bookmarks found in CSV file');
    expect(() => parseRaindropCsv('title,folder\nFoo,Bar')).toThrow(
      'CSV file must include a url column',
    );
    expect(() => parseRaindropCsv('url,title\n,Empty')).toThrow(
      'No valid bookmarks found in CSV file',
    );
  });
});

