import { useCallback, useMemo, useState } from 'react';
import { childPath, parentOf } from '../lib/folderPath';

/** Where one section of the portal's document list is open ('/', '/a/', '/a/b/'). */
export function usePathNav(root = '/') {
  const [path, setPath] = useState(root);
  const pathParts = useMemo(() => path.split('/').filter(Boolean), [path]);

  const openFolder = useCallback((name: string) => setPath((p) => childPath(p, name)), []);
  const goUp = useCallback(() => setPath((p) => parentOf(p)), []);
  /** -1 is the top; i opens the i-th folder of the current path. */
  const navigateToIndex = useCallback(
    (i: number) => setPath(i < 0 ? root : `/${pathParts.slice(0, i + 1).join('/')}/`),
    [pathParts, root],
  );

  return { path, pathParts, openFolder, goUp, navigateToIndex, inSubfolder: path !== root };
}
