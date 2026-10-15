export type UploadStatus = 'pending' | 'uploading' | 'done' | 'error';

/** One file on its way up. Matched by the File object's identity, never by index. */
export interface UploadItem {
  file: File;
  status: UploadStatus;
  targetPath: string;
}
