export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export const clock = (t: number): string => {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
export const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) e.className = String(cls);
  Object.assign(e, rest);
  for (const k of kids) e.append(k);
  return e;
}

export const C = {
  paper: '#e3e5d6',
  ink: '#20282b',
  side: ['#1f3f8c', '#a8262b'],
  sideLt: ['#5f83d6', '#d2575b'],
  brass: '#b88a1e',
  brassLt: '#c8a04a',
  good: '#3f7a4a',
  warn: '#b9812a',
  crit: '#7d1a1a',
  baize: '#1b2221',
  muted: '#a9b3a6',
};

export function strHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface ArtifactDownloads {
  save(req: { filename: string; data: string }): Promise<{ status: string }>;
}
/** Present when the page is open in the claude.ai artifact viewer, which blocks ordinary downloads. */
const viewer = (window as unknown as { claude?: { use?: (name: string) => Promise<unknown> } }).claude;
const viewerDownloads: Promise<ArtifactDownloads | null> | null = viewer?.use ? (viewer.use('downloads') as Promise<ArtifactDownloads | null>).catch(() => null) : null;

/**
 * Offer a text file to the viewer. In the artifact viewer this goes through its save prompt (the
 * viewer may decline, which is not an error); everywhere else it is an ordinary browser download.
 */
export function download(name: string, text: string): void {
  if (viewerDownloads) {
    void viewerDownloads.then(async (dl) => {
      if (!dl) return console.warn('Saving files is not available in this view.');
      try {
        await dl.save({ filename: name, data: text });
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (code !== 'declined') console.warn(`Could not save ${name}: ${code ?? e}`);
      }
    });
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: name.endsWith('.csv') ? 'text/csv' : 'application/json' }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
