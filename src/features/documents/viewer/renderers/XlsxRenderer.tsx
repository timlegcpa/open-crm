import { FileSpreadsheet } from 'lucide-react';

interface XlsxRendererProps {
  url: string;
}

export default function XlsxRenderer({ url: _url }: XlsxRendererProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-4 text-center">
      <FileSpreadsheet className="w-10 h-10 text-muted-foreground" />
      <p className="text-sm font-medium text-muted-foreground">No preview for spreadsheets</p>
      <p className="text-xs text-muted-foreground">Download the file to open it.</p>
    </div>
  );
}
