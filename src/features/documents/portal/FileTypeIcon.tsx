const LABELS: Record<string, string> = {
  pdf: 'PDF',
  xlsx: 'XLS',
  xls: 'XLS',
  csv: 'CSV',
  doc: 'DOC',
  docx: 'DOC',
  txt: 'TXT',
  png: 'PNG',
  jpg: 'JPG',
  jpeg: 'JPG',
  gif: 'GIF',
  webp: 'IMG',
};

/** A small extension tag beside a file name. Monochrome: colour is kept for status. */
export default function FileTypeIcon({ filename }: { filename: string }) {
  const ext = filename.includes('.') ? (filename.split('.').pop()?.toLowerCase() ?? '') : '';
  const label = LABELS[ext] ?? (ext.toUpperCase().slice(0, 3) || 'FILE');
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-5 w-8 shrink-0 items-center justify-center rounded-sm border border-border bg-muted text-[9px] font-bold leading-none tracking-wide text-muted-foreground"
    >
      {label}
    </span>
  );
}
