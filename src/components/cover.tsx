'use client';
import dynamic from 'next/dynamic';
import { EmojiStyle } from 'emoji-picker-react';
import { useState } from 'react';
import { Smile, ImagePlus, X } from 'lucide-react';
import { primaryVariant, type Item } from '../domain/types';
const Picker = dynamic(() => import('emoji-picker-react'), { ssr: false });
export function Cover({ item, className = '' }: { item: Item; className?: string }) {
  return (
    <div className={`cover ${className}`} data-mode={item.cover.mode}>
      {item.cover.mode === 'emoji' ? (
        <span>{item.cover.emoji || '📁'}</span>
      ) : item.cover.mode !== 'none' && item.cover.imageFile ? (
        <img
          src={`/api/media?recordId=${encodeURIComponent(item.id)}&v=${encodeURIComponent(item.updatedAt)}&hash=${encodeURIComponent(item.cover.imageHash || '')}`}
          alt=""
          loading="lazy"
        />
      ) : (
        <span className="cover-fallback">
          {item.kind === 'collection' ? '📁' : initial(primaryVariant(item)?.url)}
        </span>
      )}
    </div>
  );
}
export function CoverEditor({
  item,
  onChange,
  onUpload,
  disabled,
}: {
  item: Item;
  onChange: (cover: Item['cover']) => void;
  onUpload: (file: File) => void;
  disabled?: boolean;
}) {
  const [emoji, setEmoji] = useState(false);
  return (
    <div className="cover-editor">
      <Cover item={item} />
      <div className="cover-actions">
        <button disabled={disabled} onClick={() => setEmoji(!emoji)}>
          <Smile size={15} /> Emoji
        </button>
        <label className={`button ${disabled ? 'disabled' : ''}`}>
          <ImagePlus size={15} /> Image
          <input
            disabled={disabled}
            hidden
            type="file"
            accept="image/*"
            onChange={(e) => {
              if (e.target.files?.[0]) onUpload(e.target.files[0]);
            }}
          />
        </label>
        {item.cover.imageFile && (
          <button disabled={disabled} onClick={() => onChange({ ...item.cover, mode: 'image' })}>
            Use image
          </button>
        )}
        <button disabled={disabled} onClick={() => onChange({ ...item.cover, mode: 'none' })}>
          <X size={14} /> None
        </button>
        {item.kind === 'bookmark' && (
          <button
            disabled={disabled}
            onClick={() => onChange({ ...item.cover, mode: 'automatic' })}
          >
            Auto
          </button>
        )}
      </div>
      {emoji && (
        <div className="emoji-popover">
          <Picker
            emojiStyle={EmojiStyle.NATIVE}
            onEmojiClick={(e) => {
              onChange({ ...item.cover, mode: 'emoji', emoji: e.emoji });
              setEmoji(false);
            }}
            width="100%"
            height={360}
            lazyLoadEmojis
          />
        </div>
      )}
    </div>
  );
}

function initial(url?: string) {
  try {
    return new URL(url || 'https://example.com').hostname.slice(0, 1).toUpperCase();
  } catch {
    return '↗';
  }
}
