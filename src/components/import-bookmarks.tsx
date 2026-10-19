'use client';
import { Upload, X, ArrowUpRight } from 'lucide-react';
import {
  useEffect,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
  type FormEvent,
} from 'react';

type Props = {
  setImportOpen: Dispatch<SetStateAction<boolean>>;
  importCsv: (event: FormEvent) => Promise<void>;
  file: File | null;
  setFile: Dispatch<SetStateAction<File | null>>;
  collectionTitle?: string;
  importing: boolean;
  disabled: boolean;
  progress?: ReactNode;
};

export function ImportBookmarks({
  setImportOpen,
  importCsv,
  file,
  setFile,
  collectionTitle,
  importing,
  disabled,
  progress,
}: Props) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !importing) setImportOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [importing, setImportOpen]);

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!importing) setImportOpen(false);
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-bookmarks-title"
        className="modal"
        onSubmit={importCsv}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="modal-close icon-button"
          aria-label="Close"
          disabled={importing}
          onClick={() => setImportOpen(false)}
        >
          <X size={19} />
        </button>
        <div className="empty-icon">
          <Upload size={25} />
        </div>
        <h2 id="import-bookmarks-title">Import bookmarks</h2>
        {progress || (
          <>
            <p>
              Choose a local Raindrop CSV file to import. Collections structure will be preserved
              and created if needed.
            </p>
            <label>
              CSV file
              <input
                type="file"
                accept=".csv,text/csv"
                disabled={importing}
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </label>
            <div className="modal-footer">
              <span>Importing to {collectionTitle || 'Inbox'}</span>
              <button className="primary" disabled={!file || importing || disabled}>
                {importing ? 'Importing…' : 'Import bookmarks'}
                <ArrowUpRight size={16} />
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
