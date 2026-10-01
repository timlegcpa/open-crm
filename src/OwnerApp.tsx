import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { queryClient } from '@/lib/queryClient';
import { AppShell } from '@/components/layout/AppShell';
import { ContactsList } from '@/pages/contacts/ContactsList';
import { ContactIntake } from '@/pages/contacts/ContactIntake';
import { ContactWorkspace } from '@/pages/contacts/ContactWorkspace';

function NotFound() {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground">There is nothing at this address.</p>
      <Link to="/contacts" className="text-sm underline">Go to contacts</Link>
    </div>
  );
}

/** Everything behind the owner gate. Rendered only once the database has said "owner". */
export function OwnerApp({
  orgName,
  email,
  onSignOut,
}: {
  orgName: string | null;
  email: string;
  onSignOut: () => void;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell orgName={orgName} email={email} onSignOut={onSignOut} />}>
            <Route index element={<Navigate to="/contacts" replace />} />
            <Route path="contacts" element={<ContactsList />} />
            <Route path="contacts/new" element={<ContactIntake />} />
            <Route path="contacts/:id" element={<ContactWorkspace />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
