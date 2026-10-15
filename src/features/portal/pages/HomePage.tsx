import { Suspense, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { portalHomeCards } from '@/features/registry';
import { useAuth } from '@/lib/auth';
import { getErrorMessage } from '@/lib/errors';
import { getMyContact, listMyPendingTasks, portalKeys, settleTask, subscribeToMyTasks, type PortalTask } from '../api';
import { greetingName, isInternalTaskLink, timeOfDayGreeting } from '../lib/portalAccess';

const KIND_LABELS: Record<string, string> = {
  document_request: 'Document',
  action_item: 'To do',
  esign: 'Signature',
};

/** The portal's Home: a greeting with what is waiting, the client's tasks, then each feature's card. */
export function PortalHomePage() {
  const { session } = useAuth();
  const contact = useQuery({ queryKey: portalKeys.myContact(), queryFn: getMyContact });
  const contactId = contact.data?.id ?? null;
  const tasks = useQuery({
    queryKey: portalKeys.myTasks(contactId ?? ''),
    queryFn: () => listMyPendingTasks(contactId!),
    enabled: contactId !== null,
  });

  const queryClient = useQueryClient();
  useEffect(() => {
    if (!contactId) return;
    return subscribeToMyTasks(contactId, () => {
      void queryClient.invalidateQueries({ queryKey: portalKeys.myTasks(contactId) });
    });
  }, [contactId, queryClient]);

  const name = contact.data ? greetingName(contact.data, session?.user?.email ?? '') : null;
  const pending = tasks.data?.length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="sr-only">Home</h1>
        <p data-testid="portal-greeting" className="text-xl font-semibold">
          {timeOfDayGreeting()}
          {name ? `, ${name}` : ''}.
        </p>
        {tasks.isSuccess && (
          <p className="text-[14px] text-muted-foreground">
            {pending === 0
              ? 'Nothing needs you right now.'
              : `${pending} ${pending === 1 ? 'item needs' : 'items need'} you. Everything else is with us.`}
          </p>
        )}
      </header>
      <TasksCard contactId={contactId} tasks={tasks.data} isPending={tasks.isPending && contactId !== null} error={tasks.error} />
      {portalHomeCards.map(({ key, Component }) => (
        <section key={key} className="rounded-lg border border-border bg-card p-4">
          <Suspense fallback={null}>
            <Component />
          </Suspense>
        </section>
      ))}
    </div>
  );
}

function TasksCard({
  contactId,
  tasks,
  isPending,
  error,
}: {
  contactId: string | null;
  tasks: PortalTask[] | undefined;
  isPending: boolean;
  error: unknown;
}) {
  const { isViewAsClientSession: viewing } = useAuth();
  const queryClient = useQueryClient();
  const key = portalKeys.myTasks(contactId ?? '');

  const settle = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'completed' | 'dismissed' }) => settleTask(id, status),
    // The row leaves the list at once; it comes back if the write fails.
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<PortalTask[]>(key);
      queryClient.setQueryData<PortalTask[]>(key, (rows) => rows?.filter((row) => row.id !== id));
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      toast.error(getErrorMessage(err, 'That did not save. Try again.'));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  return (
    <section aria-labelledby="portal-tasks-heading" className="rounded-lg border border-border bg-card">
      <h2 id="portal-tasks-heading" className="border-b border-border px-4 py-2.5 text-[14px] font-semibold">
        What we need from you
      </h2>
      {isPending && <p className="px-4 py-3 text-[13px] text-muted-foreground">Loading...</p>}
      {error !== null && error !== undefined && (
        <p role="alert" className="px-4 py-3 text-[13px] text-destructive">
          Could not load your list: {getErrorMessage(error)}
        </p>
      )}
      {tasks?.length === 0 && <p className="px-4 py-3 text-[13px] text-muted-foreground">You are all caught up.</p>}
      {tasks && tasks.length > 0 && (
        <ul className="divide-y divide-border">
          {tasks.map((task) => (
            <li key={task.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium text-muted-foreground">{KIND_LABELS[task.type] ?? 'To do'}</p>
                {isInternalTaskLink(task.link) ? (
                  <Link to={task.link} className="break-words font-medium underline-offset-2 hover:underline">
                    {task.title}
                  </Link>
                ) : (
                  <p className="break-words font-medium">{task.title}</p>
                )}
                {task.description && <p className="mt-0.5 break-words text-[13px] text-muted-foreground">{task.description}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={viewing || settle.isPending}
                  title={viewing ? 'Read-only while viewing as client' : undefined}
                  onClick={() => void settle.mutateAsync({ id: task.id, status: 'completed' }).catch(() => {})}
                >
                  Mark done
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={viewing || settle.isPending}
                  title={viewing ? 'Read-only while viewing as client' : undefined}
                  onClick={() => void settle.mutateAsync({ id: task.id, status: 'dismissed' }).catch(() => {})}
                >
                  Dismiss
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
