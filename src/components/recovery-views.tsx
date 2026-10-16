'use client';
import { Trash2, History } from 'lucide-react';
import { actorId } from '../client/store';
export function TrashView({ data, mutate, disabled }: any) {
  const entries = (Object.values(data?.tombstones || {}) as any[]).filter(
    (t) => t.record && !data?.records[t.id],
  );
  return (
    <div className="record-list">
      {!entries.length && (
        <div className="empty">
          <Trash2 size={28} />
          <h2>Trash is empty</h2>
          <p>Deleted bookmarks and collections will appear here.</p>
        </div>
      )}
      {entries.map((t: any) => (
        <div className="record-row" key={t.id || t.recordId}>
          <Trash2 size={18} />
          <span>{t.record?.title || t.item?.title || t.title || t.recordId || t.id}</span>
          <button
            disabled={disabled}
            onClick={() => mutate({ type: 'restore', recordId: t.recordId || t.id })}
          >
            Restore
          </button>
          <button
            className="danger"
            disabled={disabled}
            onClick={() => {
              if (
                confirm(
                  'Permanently remove this item from the current library? Git history may retain it.',
                )
              )
                mutate({ type: 'purge', recordId: t.recordId || t.id });
            }}
          >
            Delete permanently
          </button>
        </div>
      ))}
    </div>
  );
}
export function RecoveryView({ data, mutate, disabled }: any) {
  const entries = Object.values(data?.recovery || {}) as any[];
  return (
    <div className="record-list">
      {!entries.length && (
        <div className="empty">
          <History size={28} />
          <h2>Everything is in harmony</h2>
          <p>Conflicting versions are kept here when devices disagree.</p>
        </div>
      )}
      {entries.map((r: any, i: number) => (
        <details className="recovery-entry" key={r.id || i}>
          <summary>
            {r.reason || r.field || 'Recovered change'} · {r.recordId}
          </summary>
          <pre>{JSON.stringify(r, null, 2)}</pre>
          <button
            disabled={disabled}
            onClick={() => {
              const record = {
                ...r.record,
                id: crypto.randomUUID(),
                parentId:
                  data.records[r.record.parentId]?.kind === 'collection' ? r.record.parentId : null,
                revision: { counter: 0, actor: actorId() },
              };
              mutate({ type: 'create', record });
            }}
          >
            Restore as copy
          </button>
          <button
            disabled={disabled}
            onClick={() => {
              navigator.clipboard.writeText(JSON.stringify(r, null, 2));
            }}
          >
            Copy version
          </button>
          <button
            disabled={disabled}
            className="danger"
            onClick={() => mutate({ type: 'clearRecovery', recordId: r.id })}
          >
            Clear
          </button>
        </details>
      ))}
    </div>
  );
}
