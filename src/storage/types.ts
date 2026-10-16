import type { Library, Operation } from '../domain/types';
export interface Snapshot {
  library: Library;
  revision: string;
  diagnostics: string[];
  status?: string;
}
export interface Store {
  read(): Promise<Snapshot>;
  mutate(operation: Operation): Promise<Snapshot>;
  sync(): Promise<Snapshot>;
  readMedia(id: string): Promise<Buffer | null>;
  writeMedia(id: string, data: Buffer, mode?: 'automatic' | 'image'): Promise<Snapshot>;
  exportEntries(): AsyncGenerator<{ name: string; data: Buffer }>;
  exportFiles(): Promise<Record<string, Buffer>>;
}
