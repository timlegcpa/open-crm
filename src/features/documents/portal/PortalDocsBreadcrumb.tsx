import { Fragment } from 'react';
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { ClickRegion } from '@/components/ui/click-region';
import { Home } from 'lucide-react';

interface PortalDocsBreadcrumbProps {
  pathParts: string[];
  navigateToIndex: (idx: number) => void;
  homeLabel: string;
}

export default function PortalDocsBreadcrumb({ pathParts, navigateToIndex, homeLabel }: PortalDocsBreadcrumbProps) {
  return (
    <div className="min-w-0 border-b border-border px-3.5 py-2">
      <Breadcrumb>
        <BreadcrumbList className="flex-wrap">
          <BreadcrumbItem>
            <ClickRegion
              onClick={() => navigateToIndex(-1)}
              className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground"
            >
              <Home size={13} aria-hidden="true" />
              {homeLabel}
            </ClickRegion>
          </BreadcrumbItem>
          {pathParts.map((part, i) => (
            <Fragment key={`${i}-${part}`}>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                {i === pathParts.length - 1 ? (
                  <BreadcrumbPage className="truncate text-xs font-semibold">{part}</BreadcrumbPage>
                ) : (
                  <ClickRegion
                    onClick={() => navigateToIndex(i)}
                    className="truncate rounded-sm text-xs text-muted-foreground hover:text-foreground"
                  >
                    {part}
                  </ClickRegion>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );
}
