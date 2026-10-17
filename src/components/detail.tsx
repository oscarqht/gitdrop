'use client';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { X, ExternalLink, RefreshCw, Trash2, Check } from 'lucide-react';
import { itemSchema, sortedVariants, type Item } from '../domain/types';
import { generateKeyBetween } from 'fractional-indexing';
import { CoverEditor } from './cover';
export function Detail({
  item,
  collections,
  onClose,
  onSave,
  onDelete,
  onUpload,
  onMetadata,
  disabled,
}: {
  item: Item;
  collections: Item[];
  onClose: () => void;
  onSave: (patch: Partial<Item>, base: Item) => void;
  onDelete: () => void;
  onUpload: (file: File) => void;
  onMetadata: () => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(item);
  const [base, setBase] = useState(item);
  const [tagText, setTagText] = useState(item.tags.join(', '));
  const [preview, setPreview] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) {
      setDraft(item);
      setBase(item);
      setTagText(item.tags.join(', '));
    }
  }, [item, dirty]);
  function update(patch: Partial<Item>) {
    setDraft({ ...draft, ...patch });
    setDirty(true);
  }
  function close() {
    if (!dirty || confirm('Discard unsaved changes?')) onClose();
  }
  return (
    <aside className="detail">
      <div className="detail-heading">
        <span>{item.kind === 'collection' ? 'Collection details' : 'Bookmark details'}</span>
        <button className="icon-button" aria-label="Close details" onClick={close}>
          <X size={19} />
        </button>
      </div>
      <div className="detail-body">
        <CoverEditor
          item={draft}
          disabled={disabled}
          onChange={(cover) => update({ cover })}
          onUpload={(file) => {
            if (dirty) {
              alert('Save your changes before uploading a cover.');
              return;
            }
            onUpload(file);
          }}
        />
        <label>
          Title
          <input
            disabled={disabled}
            value={draft.title}
            onChange={(e) => update({ title: e.target.value })}
          />
        </label>
        {item.kind === 'bookmark' && (
          <>
            <div className="variants">
              <div className="note-heading">
                <label>Links</label>
                <button
                  disabled={disabled}
                  onClick={() =>
                    update({
                      variants: [
                        ...(draft.variants || []),
                        {
                          id: crypto.randomUUID(),
                          name: '',
                          url: '',
                          order: generateKeyBetween(
                            sortedVariants(draft).at(-1)?.order || null,
                            null,
                          ),
                        },
                      ],
                    })
                  }
                >
                  + Add variant
                </button>
              </div>
              {sortedVariants(draft).map((variant, index) => (
                <div className="variant" key={variant.id}>
                  <div className="note-heading">
                    <label>
                      <input
                        type="radio"
                        name="default-variant"
                        disabled={disabled}
                        checked={draft.defaultVariantId === variant.id}
                        onChange={() => update({ defaultVariantId: variant.id })}
                      />{' '}
                      Default link
                    </label>
                    <button
                      className="danger"
                      disabled={disabled || draft.variants!.length < 2}
                      aria-label={`Remove link ${index + 1}`}
                      onClick={() => {
                        const variants = draft.variants!.filter((v) => v.id !== variant.id);
                        update({
                          variants,
                          defaultVariantId:
                            draft.defaultVariantId === variant.id
                              ? variants[0].id
                              : draft.defaultVariantId,
                        });
                      }}
                    >
                      Remove
                    </button>
                  </div>
                  <label>
                    Name
                    <input
                      disabled={disabled}
                      value={variant.name}
                      onChange={(e) =>
                        update({
                          variants: draft.variants!.map((v) =>
                            v.id === variant.id ? { ...v, name: e.target.value } : v,
                          ),
                        })
                      }
                    />
                  </label>
                  <div className="variant-order">
                    <button
                      disabled={disabled || index === 0}
                      onClick={() => {
                        const ordered = sortedVariants(draft);
                        const before = ordered[index - 2]?.order || null;
                        update({
                          variants: draft.variants!.map((v) =>
                            v.id === variant.id
                              ? {
                                  ...v,
                                  order: generateKeyBetween(before, ordered[index - 1].order),
                                }
                              : v,
                          ),
                        });
                      }}
                    >
                      ↑ Move up
                    </button>
                    <button
                      disabled={disabled || index === draft.variants!.length - 1}
                      onClick={() => {
                        const ordered = sortedVariants(draft);
                        update({
                          variants: draft.variants!.map((v) =>
                            v.id === variant.id
                              ? {
                                  ...v,
                                  order: generateKeyBetween(
                                    ordered[index + 1].order,
                                    ordered[index + 2]?.order || null,
                                  ),
                                }
                              : v,
                          ),
                        });
                      }}
                    >
                      ↓ Move down
                    </button>
                  </div>
                  <label>
                    URL
                    <div className="input-with-action">
                      <input
                        disabled={disabled}
                        type="url"
                        value={variant.url}
                        onChange={(e) =>
                          update({
                            variants: draft.variants!.map((v) =>
                              v.id === variant.id ? { ...v, url: e.target.value } : v,
                            ),
                          })
                        }
                      />
                      <a
                        title="Open link"
                        href={/^https?:/.test(variant.url) ? variant.url : undefined}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink size={16} />
                      </a>
                    </div>
                  </label>
                </div>
              ))}
            </div>
            <label>
              Description
              <textarea
                disabled={disabled}
                rows={3}
                value={draft.description}
                onChange={(e) => update({ description: e.target.value })}
              />
            </label>
          </>
        )}
        <label>
          {item.kind === 'collection' ? 'Parent collection' : 'Collection'}
          <select
            disabled={disabled}
            value={draft.parentId || ''}
            onChange={(e) => update({ parentId: e.target.value || null })}
          >
            {item.kind === 'collection' && <option value="">Top level</option>}
            {collections
              .filter((c) => c.id !== item.id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
          </select>
        </label>
        {item.kind === 'collection' && (
          <div className="variant-order">
            <button
              disabled={disabled}
              onClick={() => {
                const siblings = collections
                  .filter((c) => c.id !== item.id && c.parentId === draft.parentId)
                  .sort((a, b) => (a.order < b.order ? -1 : 1));
                update({ order: generateKeyBetween(null, siblings[0]?.order || null) });
              }}
            >
              Move to first
            </button>
            <button
              disabled={disabled}
              onClick={() => {
                const siblings = collections
                  .filter((c) => c.id !== item.id && c.parentId === draft.parentId)
                  .sort((a, b) => (a.order < b.order ? -1 : 1));
                update({ order: generateKeyBetween(siblings.at(-1)?.order || null, null) });
              }}
            >
              Move to last
            </button>
          </div>
        )}
        <label>
          Tags
          <input
            disabled={disabled}
            placeholder="design, reading, inspiration"
            value={tagText}
            onChange={(e) => {
              setTagText(e.target.value);
              update({
                tags: [
                  ...new Set(
                    e.target.value
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                  ),
                ],
              });
            }}
          />
        </label>
        {item.kind === 'bookmark' && (
          <>
            <div className="note-heading">
              <label>
                Note <span className="muted">Markdown</span>
              </label>
              <button onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button>
            </div>
            {preview ? (
              <div className="markdown">
                <ReactMarkdown>{draft.note || '*No note yet.*'}</ReactMarkdown>
              </div>
            ) : (
              <textarea
                className="note-input"
                disabled={disabled}
                placeholder="Your thoughts, kept with the bookmark…"
                value={draft.note}
                onChange={(e) => update({ note: e.target.value })}
              />
            )}
          </>
        )}
      </div>
      <footer className="detail-footer">
        <div>
          <button
            className="icon-button danger"
            aria-label="Move to trash"
            title="Delete"
            disabled={disabled}
            onClick={() => {
              if (
                confirm(
                  item.kind === 'collection'
                    ? 'Move this collection to trash?'
                    : 'Move this bookmark to trash?',
                )
              )
                onDelete();
            }}
          >
            <Trash2 size={17} />
          </button>
          {item.kind === 'bookmark' && (
            <button
              title="Refresh metadata"
              className="icon-button"
              disabled={disabled || dirty}
              onClick={onMetadata}
            >
              <RefreshCw size={16} />
            </button>
          )}
        </div>
        <button
          disabled={disabled || !dirty || !itemSchema.safeParse(draft).success}
          className="primary"
          onClick={() => {
            const patch: Partial<Item> = {};
            for (const field of [
              'title',
              'variants',
              'defaultVariantId',
              'description',
              'note',
              'tags',
              'parentId',
              'cover',
              'order',
            ] as const) {
              if (JSON.stringify(draft[field]) !== JSON.stringify(base[field]))
                Object.assign(patch, { [field]: draft[field] });
            }
            onSave(patch, base);
            setDirty(false);
          }}
        >
          <Check size={16} />
          Save changes
        </button>
      </footer>
    </aside>
  );
}
