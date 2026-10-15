import { Upload } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import type { UploadProgress } from './useExplorerState';

interface UploadProgressBarProps {
  progress: UploadProgress;
}

export default function UploadProgressBar({ progress }: UploadProgressBarProps) {
  const { totalFiles, completedFiles, currentFileName } = progress;
  const percent = totalFiles > 0 ? Math.round((completedFiles / totalFiles) * 100) : 0;
  const allDone = completedFiles === totalFiles;

  return (
    <div className="border-b border-border bg-muted px-4 py-2.5">
      <div className="flex items-center gap-3">
        <Upload className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs font-medium text-foreground truncate">
              {allDone ? 'Upload complete.' : `Uploading ${completedFiles + 1} of ${totalFiles}: ${currentFileName}`}
            </p>
            <span className="text-xs text-muted-foreground flex-shrink-0 ml-2">{percent}%</span>
          </div>
          <Progress value={percent} className="h-1.5" aria-label="Upload progress" />
        </div>
      </div>
    </div>
  );
}
