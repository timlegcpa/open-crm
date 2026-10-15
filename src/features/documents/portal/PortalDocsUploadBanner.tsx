import { Button } from '@/components/ui/button';
import { Surface } from '@/components/layout/page';
import { Loader2, Plus, Upload } from 'lucide-react';
import { ALLOWED_TYPES } from '../lib/documentNames';
import type { UploadItem } from './types';

interface PortalDocsUploadBannerProps {
  fileInputRef: React.RefObject<HTMLInputElement>;
  orgName: string | null;
  uploadQueue: UploadItem[];
  onUploadClick: () => void;
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

const STATUS_TEXT: Record<UploadItem['status'], string> = {
  pending: 'Waiting',
  uploading: 'Uploading',
  done: 'Done',
  error: 'Failed',
};

export default function PortalDocsUploadBanner({
  fileInputRef,
  orgName,
  uploadQueue,
  onUploadClick,
  onFileInputChange,
}: PortalDocsUploadBannerProps) {
  return (
    <>
      <Surface className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Upload size={18} aria-hidden="true" className="text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Have a document to send?</p>
            <p className="text-[13px] text-muted-foreground">Upload a file and it goes straight to {orgName ?? 'us'}.</p>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept={ALLOWED_TYPES.join(',')}
          multiple
          aria-label="Choose files to upload"
          onChange={onFileInputChange}
        />
        <Button className="shrink-0 gap-2" onClick={onUploadClick}>
          <Plus size={16} aria-hidden="true" /> Upload a document
        </Button>
      </Surface>

      {uploadQueue.length > 0 && (
        <Surface>
          <ul className="flex flex-col gap-1.5" aria-label="Uploads">
            {uploadQueue.map((item, i) => (
              <li key={`${i}-${item.file.name}`} className="flex min-w-0 items-center gap-3">
                {item.status === 'uploading' && <Loader2 size={14} aria-hidden="true" className="shrink-0 animate-spin text-muted-foreground" />}
                <p className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{item.file.name}</p>
                <span className={item.status === 'error' ? 'shrink-0 text-xs text-destructive' : 'shrink-0 text-xs text-muted-foreground'}>
                  {STATUS_TEXT[item.status]}
                </span>
              </li>
            ))}
          </ul>
        </Surface>
      )}
    </>
  );
}
