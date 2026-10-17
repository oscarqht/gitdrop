'use client';
import { Plus, X, ArrowUpRight } from 'lucide-react';
import type { Dispatch, SetStateAction, FormEvent } from 'react';
type Props = {
  setAdd: Dispatch<SetStateAction<boolean>>;
  saveUrl: (event: FormEvent) => Promise<void>;
  url: string;
  setUrl: Dispatch<SetStateAction<string>>;
  collectionTitle?: string;
  adding: boolean;
  disabled: boolean;
};
export function AddBookmark({
  setAdd,
  saveUrl,
  url,
  setUrl,
  collectionTitle,
  adding,
  disabled,
}: Props) {
  return (
    <div className="modal-backdrop" onClick={() => setAdd(false)}>
      <form className="modal" onSubmit={saveUrl} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="modal-close icon-button"
          aria-label="Close"
          onClick={() => setAdd(false)}
        >
          <X size={19} />
        </button>
        <div className="empty-icon">
          <Plus size={25} />
        </div>
        <h2>Found something good?</h2>
        <p>Paste a link. We’ll take care of the details.</p>
        <label>
          Website URL
          <input
            autoFocus
            required
            placeholder="https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <div className="modal-footer">
          <span>Saving to {collectionTitle || 'Inbox'}</span>
          <button className="primary" disabled={adding || disabled}>
            {adding ? 'Saving…' : 'Save bookmark'}
            <ArrowUpRight size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
