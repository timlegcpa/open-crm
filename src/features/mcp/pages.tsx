// Placeholders: the connector feature replaces these.

/** The consent screen an AI assistant opens when it asks to connect. No shell around it: it runs in a popup. */
export function ConnectPage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <div className="flex max-w-sm flex-col gap-2 text-center">
        <h1 className="text-lg font-semibold">Connect an assistant</h1>
        <p className="text-[13px] text-muted-foreground">Approve or refuse an AI assistant's request to use this CRM.</p>
      </div>
    </main>
  );
}

export function ConnectorSettings() {
  return <p className="text-[13px] text-muted-foreground">Connected assistants, and the switch that turns the connector off.</p>;
}
