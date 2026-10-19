'use client';
import { useState } from 'react';
import { ChevronDown, Upload, X } from 'lucide-react';
import { importComplete, importCounts, type ImportJob } from '../client/import-job';

type Props = {
  job: ImportJob;
  mode: 'local' | 'github';
  expanded?: boolean;
  control: (command: 'pause' | 'resume' | 'retry' | 'dismiss') => Promise<void>;
};
export function ImportProgress({ job, mode, expanded = false, control }: Props) {
  const [open, setOpen] = useState(expanded);
  const counts = importCounts(job);
  const saved = job.saved === job.entries.length;
  const complete = importComplete(job);
  const title = job.error
    ? 'Import needs attention'
    : complete
      ? counts.covers.failed
        ? 'Import finished with cover errors'
        : 'Import complete'
      : job.paused
        ? 'Import paused'
        : saved
          ? 'Bookmarks saved · Fetching covers'
          : mode === 'github'
            ? 'Saving import to GitHub'
            : 'Saving import locally';
  const act = (command: Parameters<Props['control']>[0]) => {
    void control(command).catch(() => {});
  };
  return (
    <section className="import-progress" aria-label="Import progress">
      <div className="import-progress-heading">
        <button
          type="button"
          className="import-progress-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Upload size={17} />
          <span>
            <strong>{title}</strong>
            <small>
              {saved
                ? `Covers ${counts.covers.processed.toLocaleString()} / ${counts.covers.total.toLocaleString()} processed`
                : `${job.saved.toLocaleString()} / ${job.entries.length.toLocaleString()} records saved`}
            </small>
          </span>
          <ChevronDown size={16} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
        </button>
        {complete && (
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss import summary"
            onClick={() => act('dismiss')}
          >
            <X size={16} />
          </button>
        )}
      </div>
      {open && (
        <div className="import-progress-details">
          <p className="import-file-name" title={job.name}>
            {job.name}
          </p>
          <div className="import-counter">
            <span>Collections saved</span>
            <strong>
              {counts.collections.saved.toLocaleString()} /{' '}
              {counts.collections.total.toLocaleString()}
            </strong>
          </div>
          <progress
            aria-label="Collections saved"
            max={counts.collections.total || 1}
            value={counts.collections.saved}
          />
          <div className="import-counter">
            <span>Bookmarks saved</span>
            <strong>
              {counts.bookmarks.saved.toLocaleString()} / {counts.bookmarks.total.toLocaleString()}
            </strong>
          </div>
          <progress
            aria-label="Bookmarks saved"
            max={counts.bookmarks.total || 1}
            value={counts.bookmarks.saved}
          />
          <div className="import-counter">
            <span>Covers processed</span>
            <strong>
              {counts.covers.processed.toLocaleString()} / {counts.covers.total.toLocaleString()}
            </strong>
          </div>
          <progress
            aria-label="Covers processed"
            max={counts.covers.total || 1}
            value={counts.covers.processed}
          />
          <p>
            {counts.covers.fetched.toLocaleString()} fetched ·{' '}
            {counts.covers.unavailable.toLocaleString()} unavailable ·{' '}
            {counts.covers.failed.toLocaleString()} failed
          </p>
          {job.error && (
            <p role="alert" className="import-progress-error">
              {job.error}
            </p>
          )}
          {!complete && (
            <p>
              {job.paused
                ? 'Pausing takes effect after the current batch finishes.'
                : saved
                  ? 'Your bookmarks are ready to use. Covers continue in the background.'
                  : 'You can keep browsing and editing. Saved counts update after each confirmed batch.'}{' '}
              Progress resumes when you return to this browser.
            </p>
          )}
          {counts.covers.failed > 0 && (
            <details>
              <summary>Failed covers</summary>
              <ul>
                {job.entries
                  .filter((e) => e.coverStatus === 'failed')
                  .map((e) => (
                    <li key={e.item.id}>
                      <strong>{e.item.title}</strong>
                      <small>{e.coverError}</small>
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </div>
      )}
      <div className="import-progress-actions">
        {!complete && !job.error && (
          <button type="button" onClick={() => act(job.paused ? 'resume' : 'pause')}>
            {job.paused ? 'Resume' : 'Pause'}
          </button>
        )}
        {job.error && (
          <button type="button" onClick={() => act('resume')}>
            Retry saving
          </button>
        )}
        {complete && counts.covers.failed > 0 && (
          <button type="button" onClick={() => act('retry')}>
            Retry failed covers
          </button>
        )}
        <span role="status" aria-live="polite">
          {complete
            ? 'All bookmark data saved'
            : job.error
              ? 'Progress kept on this device'
              : job.paused
                ? 'Paused · progress saved'
                : 'One import at a time'}
        </span>
      </div>
    </section>
  );
}
