import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

type PropsOf<C> = C extends ComponentType<infer P> ? P : never;

/**
 * `React.lazy` for a module's NAMED export, so pages need no default export:
 *
 *   const DocumentsPage = lazyNamed(() => import('./pages/DocumentsPage'), 'DocumentsPage');
 *
 * The module loads the first time the component renders; until then a Suspense boundary
 * (the shell, the portal frame and the public router each provide one) shows its fallback.
 */
export function lazyNamed<M, K extends keyof M>(
  load: () => Promise<M>,
  key: K,
): LazyExoticComponent<ComponentType<PropsOf<M[K]>>> {
  return lazy(async () => ({ default: (await load())[key] as unknown as ComponentType<PropsOf<M[K]>> }));
}
