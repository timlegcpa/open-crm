import { FolderPlus, Upload, Download, ArrowRightLeft, Trash2, CheckCheck, FolderInput } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SECTIONS, SECTION_ICON, SECTION_LABEL, type ActiveSection, type Section } from './useExplorerState';
import { cn } from '@/lib/utils';

interface ExplorerToolbarProps {
  activeSection: ActiveSection;
  /**
   * Both take the section the new folder or upload lands in. Inside a section
   * that is the active one; at the contact's root there is none, so the button
   * becomes a two-item menu (one per section) and passes the pick.
   * These are the ONLY two verbs that need a section chosen: every row action
   * resolves its own from the row.
   */
  onNewFolder: (section: Section) => void;
  onUploadClick: (section: Section) => void;
  // Bulk selection props
  selectedCount?: number;
  onBulkDelete?: () => void;
  onBulkDownload?: () => void;
  onBulkMove?: () => void;
  onBulkMoveToShared?: () => void;
  onBulkReview?: () => void;
  onClearSelection?: () => void;
  /** False where the page draws `CreateButtons` beside the files instead. */
  showCreate?: boolean;
}

const TOOLBAR_BUTTON = 'h-8 gap-1.5 text-xs [&_svg]:size-3.5';

/**
 * New folder and Upload for ONE section, as two plain buttons, so adding a folder
 * is never buried in a corner. They sit where the files are: on each section's
 * heading at a contact's root, and on the path bar inside a folder.
 */
export function CreateButtons({
  section,
  onNewFolder,
  onUploadClick,
  size = 'sm',
}: {
  section: Section;
  onNewFolder: (section: Section) => void;
  onUploadClick: (section: Section) => void;
  size?: 'sm' | 'xs';
}) {
  const cls = size === 'xs' ? 'h-7 gap-1.5 px-2.5 text-xs [&_svg]:size-3.5' : TOOLBAR_BUTTON;
  return (
    <>
      <Button variant="outline" size="sm" className={cls} onClick={() => onNewFolder(section)}>
        <FolderPlus className="w-3.5 h-3.5" />
        New folder
      </Button>
      <Button variant="outline" size="sm" className={cls} onClick={() => onUploadClick(section)}>
        <Upload className="w-3.5 h-3.5" />
        Upload
      </Button>
    </>
  );
}

/** New folder / Upload: a plain button inside a section, a section picker at the root. */
function SectionButton({
  activeSection,
  icon: Icon,
  label,
  onPick,
}: {
  activeSection: ActiveSection;
  icon: typeof FolderPlus;
  label: string;
  onPick: (section: Section) => void;
}) {
  if (activeSection) {
    return (
      <Button variant="outline" size="sm" className={TOOLBAR_BUTTON} onClick={() => onPick(activeSection)}>
        <Icon className="w-3.5 h-3.5" />
        {label}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={TOOLBAR_BUTTON}>
          <Icon className="w-3.5 h-3.5" />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SECTIONS.map((section) => {
          const Icon = SECTION_ICON[section];
          return (
            <DropdownMenuItem key={section} onSelect={() => onPick(section)} className="gap-2">
              <Icon className={cn('w-3.5 h-3.5', 'text-muted-foreground')} />
              {SECTION_LABEL[section]}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function ExplorerToolbar({
  activeSection,
  onNewFolder,
  onUploadClick,
  selectedCount = 0,
  onBulkDelete,
  onBulkDownload,
  onBulkMove,
  onBulkMoveToShared,
  onBulkReview,
  onClearSelection,
  showCreate = true,
}: ExplorerToolbarProps) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {/* Left: bulk actions when items selected */}
      {selectedCount > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{selectedCount} selected</span>
          {onBulkDownload && (
            <Button variant="outline" size="sm" className={TOOLBAR_BUTTON} onClick={onBulkDownload}>
              <Download className="w-3.5 h-3.5" /> Download
            </Button>
          )}
          {onBulkMove && (
            <Button variant="outline" size="sm" className={TOOLBAR_BUTTON} onClick={onBulkMove}>
              <FolderInput className="w-3.5 h-3.5" /> Move
            </Button>
          )}
          {onBulkMoveToShared && (
            <Button variant="outline" size="sm" className={TOOLBAR_BUTTON} onClick={onBulkMoveToShared}>
              <ArrowRightLeft className="w-3.5 h-3.5" /> Move to shared
            </Button>
          )}
          {onBulkReview && (
            <Button variant="outline" size="sm" className={cn(TOOLBAR_BUTTON, 'text-success hover:text-success-dark hover:bg-success-light')} onClick={onBulkReview}>
              <CheckCheck className="w-3.5 h-3.5" /> Mark reviewed
            </Button>
          )}
          {onBulkDelete && (
            <Button variant="outline" size="sm" className={cn(TOOLBAR_BUTTON, 'text-destructive hover:text-destructive-dark hover:bg-destructive-light')} onClick={onBulkDelete}>
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </Button>
          )}
          {onClearSelection && (
            <Button type="button" variant="ghost" onClick={onClearSelection} className="h-auto p-0 font-normal text-xs text-muted-foreground hover:bg-transparent hover:text-foreground ml-1">
              Clear
            </Button>
          )}
        </div>
      ) : null}

      {/* Always show New folder + Upload; at the contact's root each asks which section. */}
      {showCreate && (
        <div className="flex items-center gap-2">
          <SectionButton activeSection={activeSection} icon={FolderPlus} label="New folder" onPick={onNewFolder} />
          <SectionButton activeSection={activeSection} icon={Upload} label="Upload" onPick={onUploadClick} />
        </div>
      )}
    </div>
  );
}
