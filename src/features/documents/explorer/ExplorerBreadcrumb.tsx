import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { SECTION_LABEL, type ActiveSection } from './useExplorerState';

interface ExplorerBreadcrumbProps {
  clientName: string;
  activeSection: ActiveSection;
  currentPath: string;
  onGoToClientRoot: () => void;
  onNavigateToBreadcrumb: (index: number) => void;
}

export default function ExplorerBreadcrumb({
  clientName,
  activeSection,
  currentPath,
  onGoToClientRoot,
  onNavigateToBreadcrumb,
}: ExplorerBreadcrumbProps) {
  const segments = currentPath.split('/').filter(Boolean);
  const sectionLabel = activeSection ? SECTION_LABEL[activeSection] : '';

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <button type="button" onClick={onGoToClientRoot} className="max-w-[40vw] truncate">
              {clientName}
            </button>
          </BreadcrumbLink>
        </BreadcrumbItem>

        {activeSection && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              {segments.length === 0 ? (
                <BreadcrumbPage>{sectionLabel}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <button type="button" onClick={() => onNavigateToBreadcrumb(-1)}>
                    {sectionLabel}
                  </button>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </>
        )}

        {segments.map((seg, i) => (
          <span key={`${i}-${seg}`} className="contents">
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              {i === segments.length - 1 ? (
                <BreadcrumbPage>{seg}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <button type="button" onClick={() => onNavigateToBreadcrumb(i)} className="max-w-[30vw] truncate">
                    {seg}
                  </button>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </span>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
