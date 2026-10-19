import { it, expect, vi, afterEach } from 'vitest';
import { GitHubStore } from '../src/storage/github';
import { createLibrary, makeItem, applyOperation } from '../src/domain/operations';
import { encodeFiles, gitBlobHash, decodeFiles } from '../src/storage/codec';
afterEach(() => vi.unstubAllGlobals());
it.each(['normal', 'race', 'lost-response', 'cover-batch', 'import-batch', 'large-import', 'thousand-import', 'delete', 'move-cover', 'graphql-error', 'graphql-rate-limit'])(
  'reads verified shards and publishes safely: %s',
  async (scenario) => {
    const library = createLibrary();
    const item = makeItem('bookmark', { title: 'Shared', url: 'https://example.com' });
    library.records[item.id] = item;
    const second = makeItem('bookmark', { title: 'Second', url: 'https://second.example.com' });
    const manual = makeItem('bookmark', { title: 'Manual', url: 'https://manual.example.com', cover: { mode: 'emoji', emoji: '⭐' } });
    if (scenario === 'cover-batch') { library.records[second.id] = second; library.records[manual.id] = manual; }
    let files = encodeFiles(library);
    let head = 'head0';
    let treeId = 'tree0';
    const blobs = new Map<string, Buffer>();
    const trees = new Map<string, any[]>();
    const commits = new Map<string, { tree: { sha: string } }>();
    let index = 0;
    const refresh = () => {
      const tree = [...files].map(([path, b]) => {
        const sha = gitBlobHash(b);
        blobs.set(sha, b);
        return { path, sha, type: 'blob', mode: '100644' };
      });
      trees.set(treeId, tree);
      commits.set(head, { tree: { sha: treeId } });
    };
    refresh();
    const updates: any[] = [];
    let uploading = 0;
    let maxUploading = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: any) => {
        const route = new URL(input).pathname.replace('/repos/test/library', '');
        const body = init.body ? JSON.parse(init.body) : null;
        let result: any;
        if (route === '/graphql') {
          expect(init.headers['Content-Type']).toBe('application/json');
          if (scenario === 'graphql-error' || scenario === 'graphql-rate-limit')
            return new Response(JSON.stringify({ errors: [{ type: scenario === 'graphql-error' ? 'FORBIDDEN' : 'RATE_LIMITED' }] }));
          const change = body.variables.input;
          expect(change.branch).toEqual({ repositoryNameWithOwner: 'test/library', branchName: 'main' });
          updates.push({ force: false });
          if (scenario === 'race' && updates.length === 1) {
            const remoteLibrary = applyOperation(decodeFiles(files).library, {
              id: 'remote-edit', actor: 'other', type: 'update', recordId: item.id,
              patch: { note: 'Remote note' },
            });
            files = encodeFiles(remoteLibrary, files, decodeFiles(files).paths);
            head = 'concurrent-head'; treeId = 'concurrent-tree'; refresh();
          }
          if (change.expectedHeadOid !== head)
            return new Response(JSON.stringify({ errors: [{ type: 'UNPROCESSABLE', message: 'Expected head does not match' }] }));
          for (const deletion of change.fileChanges.deletions) files.delete(deletion.path);
          for (const addition of change.fileChanges.additions) files.set(addition.path, Buffer.from(addition.contents, 'base64'));
          head = `head${++index}`; treeId = `tree${++index}`; refresh();
          result = { data: { createCommitOnBranch: { commit: { oid: head } } } };
          if (scenario === 'lost-response' && updates.length === 1)
            throw new Error('Connection lost after publish');
        } else if (route === '/git/ref/heads/main') result = { object: { sha: head } };
        else if (route.startsWith('/git/commits/') && init.method === 'GET')
          result = commits.get(route.split('/').pop()!);
        else if (route.startsWith('/git/trees/') && init.method === 'GET')
          result = { tree: trees.get(route.split('/').pop()!), truncated: false };
        else if (route.startsWith('/git/blobs/') && init.method === 'GET')
          result = { content: blobs.get(route.split('/').pop()!)!.toString('base64') };
        else if (route === '/git/blobs') {
          uploading++; maxUploading = Math.max(maxUploading, uploading);
          await new Promise(resolve => setTimeout(resolve, 2));
          uploading--;
          const data = Buffer.from(body.content, 'base64');
          const sha = gitBlobHash(data);
          blobs.set(sha, data);
          result = { sha };
        } else if (route === '/git/trees') {
          const entries = new Map(trees.get(body.base_tree)!.map((e) => [e.path, e]));
          for (const e of body.tree) {
            if (e.sha === null) entries.delete(e.path);
            else if (typeof e.content === 'string') {
              const data = Buffer.from(e.content, 'utf8');
              const sha = gitBlobHash(data);
              blobs.set(sha, data);
              entries.set(e.path, { path: e.path, mode: e.mode, type: e.type, sha });
            } else entries.set(e.path, e);
          }
          treeId = `tree${++index}`;
          trees.set(treeId, [...entries.values()]);
          result = { sha: treeId };
        } else if (route === '/git/commits') {
          const sha = `head${++index}`;
          commits.set(sha, { tree: { sha: body.tree } });
          result = { sha };
        } else if (route === '/git/refs/heads/main') {
          updates.push(body);
          if (scenario === 'race' && updates.length === 1) {
            const remoteLibrary = applyOperation(decodeFiles(files).library, {
              id: 'remote-edit',
              actor: 'other',
              type: 'update',
              recordId: item.id,
              patch: { note: 'Remote note' },
            });
            files = encodeFiles(remoteLibrary, files, decodeFiles(files).paths);
            head = 'concurrent-head';
            treeId = 'concurrent-tree';
            refresh();
            return new Response('{}', { status: 409 });
          }
          head = body.sha;
          files = new Map(
            trees.get(commits.get(head)!.tree.sha)!.map((e) => [e.path, blobs.get(e.sha)!]),
          );
          result = { object: { sha: head } };
          if (scenario === 'lost-response' && updates.length === 1)
            throw new Error('Connection lost after publish');
        } else throw new Error(route);
        return new Response(JSON.stringify(result), { status: 200 });
      }),
    );
    const store = new GitHubStore('test', 'library', 'secret');
    expect((await store.read()).library.records[item.id].title).toBe('Shared');
    if (scenario === 'graphql-error' || scenario === 'graphql-rate-limit') {
      await expect(store.mutate({ id: 'denied', actor: 'test', type: 'update', recordId: item.id, patch: { title: 'Never saved' } })).rejects.toThrow(scenario === 'graphql-error' ? 'permissions' : 'rate limit');
      expect(decodeFiles(files).library.records[item.id].title).toBe('Shared');
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/graphql'))).toHaveLength(1);
      return;
    }
    if (scenario === 'delete') {
      const result = await store.mutate({ id: 'delete', actor: 'test', type: 'delete', recordId: item.id });
      expect(result.library.records[item.id]).toBeUndefined();
      expect(decodeFiles(files).library.tombstones[item.id].record?.title).toBe(item.title);
      const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/graphql'))!;
      expect(JSON.parse(String(call[1]?.body)).variables.input.fileChanges.deletions.length).toBeGreaterThan(0);
      return;
    }
    if (scenario === 'move-cover') {
      const image = Buffer.from([0, 255, 3, 128, 2]);
      await store.writeMedia(item.id, image);
      const folder = makeItem('collection', { title: 'Destination' });
      await store.mutate({ id: 'folder', actor: 'test', type: 'create', record: folder });
      vi.mocked(fetch).mockClear();
      const result = await store.mutate({ id: 'move', actor: 'test', type: 'update', recordId: item.id, patch: { parentId: folder.id } });
      expect(result.library.records[item.id].parentId).toBe(folder.id);
      expect(await store.readMedia(item.id)).toEqual(image);
      expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).endsWith('/git/trees') && init?.method === 'POST')).toBe(true);
      return;
    }
    if (scenario === 'thousand-import') {
      vi.mocked(fetch).mockClear();
      const records = Array.from({ length: 1000 }, (_, i) => makeItem('bookmark', {
        title: `Imported ${i}`, url: `https://example.test/${i}`,
      }));
      for (let i = 0; i < records.length; i += 100)
        await store.mutate({ id: `import-${i}`, actor: 'csv-import', type: 'create', records: records.slice(i, i + 100) });
      const saveCalls = vi.mocked(fetch).mock.calls.length;
      for (let i = 0; i < records.length; i += 20) {
        await store.read(); // Each cover endpoint starts with a fresh library snapshot.
        await store.writeImportCovers(records.slice(i, i + 20).map(record => ({
          id: record.id, url: record.variants![0].url, data: Buffer.from(`image-${record.id}`),
        })));
      }
      const calls = vi.mocked(fetch).mock.calls;
      expect(saveCalls).toBe(50);
      expect(calls).toHaveLength(350);
      expect(calls.filter(([url]) => String(url).endsWith('/graphql'))).toHaveLength(60);
      expect(calls.filter(([url, init]) => String(url).endsWith('/git/blobs') && init?.method === 'POST')).toHaveLength(0);
      expect(Object.values(decodeFiles(files).library.records).filter(record => record.cover.imageHash)).toHaveLength(1000);
      return;
    }
    if (scenario === 'cover-batch') {
      const result = await store.writeImportCovers([item, second, manual].map(record => ({
        id: record.id, url: record.variants![0].url, data: Buffer.from(`image-${record.id}`),
      })));
      expect(result.library.records[item.id].cover.imageHash).toBeTruthy();
      expect(result.library.records[second.id].cover.imageHash).toBeTruthy();
      expect(result.library.records[manual.id].cover).toEqual(manual.cover);
      expect(updates).toHaveLength(1);
      expect(maxUploading).toBe(0);
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/graphql'))).toHaveLength(1);
      const again = await store.writeImportCovers([{ id: item.id, url: item.variants![0].url, data: Buffer.from('replacement') }]);
      expect(again.library.records[item.id].cover.imageHash).toBe(result.library.records[item.id].cover.imageHash);
      expect(updates).toHaveLength(1);
      return;
    }
    if (scenario === 'import-batch' || scenario === 'large-import') {
      vi.mocked(fetch).mockClear();
      const records = Array.from({ length: 100 }, (_, i) => makeItem('collection', {
        title: `Collection ${i} 收藏 📚`,
        ...(scenario === 'large-import' && i < 10 ? { note: 'x'.repeat(200_000) } : {}),
      }));
      const result = await store.mutate({
        id: 'import-0', actor: 'csv-import', type: 'create', records,
      });
      expect(Object.keys(result.library.records)).toHaveLength(101);
      expect(decodeFiles(files).diagnostics).toEqual([]);
      const decoded = decodeFiles(files);
      for (const record of records)
        expect(decoded.library.records[record.id]).toMatchObject({ title: record.title, note: record.note });
      const calls = vi.mocked(fetch).mock.calls;
      const uploads = calls.filter(([url, init]) => String(url).endsWith('/git/blobs') && init?.method === 'POST');
      if (scenario === 'import-batch') {
        expect(uploads).toHaveLength(0);
        expect(calls.length).toBeLessThan(15);
      } else {
        expect(uploads.length).toBeGreaterThan(0);
        const treeCall = calls.find(([url, init]) => String(url).endsWith('/git/trees') && init?.method === 'POST')!;
        const tree = JSON.parse(String(treeCall[1]!.body)).tree;
        const bytes = tree.reduce((sum: number, entry: any) => sum + Buffer.byteLength(entry.content ?? ''), 0);
        expect(bytes).toBeLessThanOrEqual(4_000_000);
      }
      expect(updates).toHaveLength(1);
      return;
    }
    const result = await store.mutate({
      id: 'edit',
      actor: 'mobile',
      type: 'update',
      recordId: item.id,
      base: item,
      patch: { title: 'Updated' },
    });
    expect(result.library.records[item.id].title).toBe('Updated');
    expect(updates).toHaveLength(scenario === 'race' ? 2 : 1);
    if (scenario === 'race') expect(result.library.records[item.id].note).toBe('Remote note');
    expect(updates[0].force).toBe(false);
    expect(decodeFiles(files).library.records[item.id].title).toBe('Updated');
  },
  30_000,
);

it('bounds rate-limit retries and obeys Retry-After', async () => {
  const request = vi.fn(
    async () => new Response('{}', { status: 429, headers: { 'Retry-After': '0' } }),
  );
  vi.stubGlobal('fetch', request);
  await expect(new GitHubStore('test', 'library', 'token').read()).rejects.toThrow('rate limit');
  expect(request).toHaveBeenCalledTimes(3);
});
it('does not retry authorization failures', async () => {
  const request = vi.fn(async () => new Response('{}', { status: 403 }));
  vi.stubGlobal('fetch', request);
  await expect(new GitHubStore('test', 'library', 'token').read()).rejects.toThrow('403');
  expect(request).toHaveBeenCalledTimes(1);
});
it('leaves long rate-limit waits to the pending queue', async () => {
  const request = vi.fn(
    async () => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }),
  );
  vi.stubGlobal('fetch', request);
  await expect(new GitHubStore('test', 'library', 'token').read()).rejects.toThrow('rate limit');
  expect(request).toHaveBeenCalledTimes(1);
});

function mockReadRepository() {
  const initial=createLibrary();const item=makeItem('bookmark',{id:'bookmark',title:'One',url:'https://example.com'});initial.records[item.id]=item;
  let version=0;let files=encodeFiles(initial);const blobs=new Map<string,Buffer>();
  const calls:string[]=[];
  const mock=vi.fn(async(input:string)=>{
    const route=new URL(input).pathname.replace('/repos/test/library','');calls.push(route);
    let value:any;
    if(route==='/git/ref/heads/main')value={object:{sha:`head${version}`}};
    else if(route.startsWith('/git/commits/'))value={tree:{sha:`tree${version}`}};
    else if(route.startsWith('/git/trees/'))value={truncated:false,tree:[...files].map(([path,data])=>{const sha=gitBlobHash(data);blobs.set(sha,data);return {path,sha,type:'blob',mode:'100644'};})};
    else if(route.startsWith('/git/blobs/')){const data=blobs.get(route.split('/').at(-1)!);if(!data)return new Response('{}',{status:404});value={content:data.toString('base64')};}
    else throw new Error(route);
    return new Response(JSON.stringify(value));
  });
  vi.stubGlobal('fetch',mock);
  return {calls,blobs,advance(){version++;const parsed=decodeFiles(files);const next=applyOperation(parsed.library,{id:`edit${version}`,actor:'remote',type:'update',recordId:'bookmark',patch:{title:`Title${version}`}});files=encodeFiles(next,files,parsed.paths);}};
}
it('reuses unchanged decoded state and checks only HEAD on repeated reads',async()=>{
  const repo=mockReadRepository();const store=new GitHubStore('test','library','secret');
  const first=await store.read();first.library.records.bookmark.title='Do not mutate cache';
  repo.calls.length=0;const second=await store.read();
  expect(second.library.records.bookmark.title).toBe('One');expect(repo.calls).toEqual(['/git/ref/heads/main']);
  repo.advance();repo.calls.length=0;const third=await store.read();
  expect(third.library.records.bookmark.title).toBe('Title1');expect(repo.calls.some(r=>r.startsWith('/git/trees/'))).toBe(true);
});
it('coalesces simultaneous loads and reuses unchanged immutable shards across heads',async()=>{
  const repo=mockReadRepository();const store=new GitHubStore('test','library','secret');
  await Promise.all([store.read(),store.read(),store.read()]);
  expect(repo.calls.filter(r=>r==='/git/ref/heads/main')).toHaveLength(1);
  const fetched=repo.calls.filter(r=>r.startsWith('/git/blobs/'));expect(new Set(fetched).size).toBe(fetched.length);
  repo.advance();repo.calls.length=0;await store.read();
  const second=repo.calls.filter(r=>r.startsWith('/git/blobs/'));expect(second.every(r=>!fetched.includes(r))).toBe(true);
});
it('loads covers directly by validated hash without fetching repository metadata',async()=>{
  const repo=mockReadRepository();const data=Buffer.from('image');const hash=gitBlobHash(data);repo.blobs.set(hash,data);
  const store=new GitHubStore('test','library','secret');const result=await store.readMediaByHash(hash);expect(result).toEqual(data);
  expect(repo.calls).toEqual([`/git/blobs/${hash}`]);result[0]=0;
  expect(await store.readMediaByHash(hash)).toEqual(data);expect(repo.calls).toHaveLength(1);
  await expect(store.readMediaByHash('../bad')).rejects.toThrow('Invalid image hash');
});
it('rejects oversized cover responses and mismatched blob hashes',async()=>{
  const repo=mockReadRepository();const large=Buffer.alloc(8*1024*1024+1);const hash=gitBlobHash(large);repo.blobs.set(hash,large);
  const store=new GitHubStore('test','library','secret');await expect(store.readMediaByHash(hash)).rejects.toThrow('size limit');
  repo.blobs.set('a'.repeat(40),Buffer.from('wrong'));await expect(store.readMediaByHash('a'.repeat(40))).rejects.toThrow('hash mismatch');
});
