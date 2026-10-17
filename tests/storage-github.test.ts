import { it, expect, vi, afterEach } from 'vitest';
import { GitHubStore } from '../src/storage/github';
import { createLibrary, makeItem, applyOperation } from '../src/domain/operations';
import { encodeFiles, gitBlobHash, decodeFiles } from '../src/storage/codec';
afterEach(() => vi.unstubAllGlobals());
it.each(['normal', 'race', 'lost-response'])(
  'reads verified shards and publishes safely: %s',
  async (scenario) => {
    const library = createLibrary();
    const item = makeItem('bookmark', { title: 'Shared', url: 'https://example.com' });
    library.records[item.id] = item;
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: any) => {
        const route = new URL(input).pathname.replace('/repos/test/library', '');
        const body = init.body ? JSON.parse(init.body) : null;
        let result: any;
        if (route === '/git/ref/heads/main') result = { object: { sha: head } };
        else if (route.startsWith('/git/commits/') && init.method === 'GET')
          result = commits.get(route.split('/').pop()!);
        else if (route.startsWith('/git/trees/') && init.method === 'GET')
          result = { tree: trees.get(route.split('/').pop()!), truncated: false };
        else if (route.startsWith('/git/blobs/') && init.method === 'GET')
          result = { content: blobs.get(route.split('/').pop()!)!.toString('base64') };
        else if (route === '/git/blobs') {
          const data = Buffer.from(body.content, 'base64');
          const sha = gitBlobHash(data);
          blobs.set(sha, data);
          result = { sha };
        } else if (route === '/git/trees') {
          const entries = new Map(trees.get(body.base_tree)!.map((e) => [e.path, e]));
          for (const e of body.tree) {
            if (e.sha === null) entries.delete(e.path);
            else entries.set(e.path, e);
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
