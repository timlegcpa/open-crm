import { useState, useRef, useCallback } from 'react';
import { Upload } from 'lucide-react';

interface UploadDropZoneProps {
  children: React.ReactNode;
  enabled: boolean;
  onDrop: (files: File[]) => void;
}

export default function UploadDropZone({ children, enabled, onDrop }: UploadDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!enabled) return;
    // No upload overlay for a drag of the explorer's own rows.
    if (e.dataTransfer.types.includes('application/x-explorer-file')) return;
    if (e.dataTransfer.types.includes('application/x-explorer-folder')) return;
    dragCounter.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }, [enabled]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;
    if (!enabled) return;
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      onDrop(droppedFiles);
    }
  }, [enabled, onDrop]);

  return (
    <div
      className="relative h-full"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-foreground/40 bg-background/90">
          <div className="text-center">
            <Upload className="mx-auto mb-2 h-10 w-10 text-foreground" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">Drop files here to upload</p>
          </div>
        </div>
      )}
    </div>
  );
}
