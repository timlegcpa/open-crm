import { useId, useMemo } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { fullPathOf, type FolderPathRow } from './types';

/**
 * The destination picker every move dialog shares: the section's top level, then every
 * folder of the section as a tree reads, minus the folders `excludedIds` names and
 * everything under them (a folder cannot move into itself).
 */
export default function FolderDestinationSelect({
  folders,
  value,
  onChange,
  excludedIds = [],
  label = 'Destination',
}: {
  folders: readonly FolderPathRow[];
  value: string;
  onChange: (path: string) => void;
  excludedIds?: readonly string[];
  label?: string;
}) {
  const labelId = useId();
  const options = useMemo(() => {
    const excluded = new Set(excludedIds);
    const excludedPrefixes = folders.filter((r) => excluded.has(r.id)).map(fullPathOf);
    const rows = folders
      .map((r) => ({ value: fullPathOf(r), label: r.name }))
      .filter((r) => !excludedPrefixes.some((p) => r.value.startsWith(p)))
      .map((r) => ({ ...r, depth: r.value.split('/').filter(Boolean).length }))
      .sort((a, b) => a.value.localeCompare(b.value, undefined, { sensitivity: 'base', numeric: true }));
    return [{ value: '/', label: 'Top level', depth: 0 }, ...rows];
  }, [folders, excludedIds]);

  return (
    <div>
      <p id={labelId} className="mb-1 block text-sm font-medium text-foreground">{label}</p>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-9" aria-labelledby={labelId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.depth > 1 ? ' '.repeat((opt.depth - 1) * 3) : ''}{opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
