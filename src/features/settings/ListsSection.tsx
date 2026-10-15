import { CONTACT_STATUSES, LEAD_SOURCES, ORGANIZATION_TYPES, SERVICE_TYPES } from '@/api/pickLists';
import { PickListEditor } from './PickListEditor';

/**
 * The core pick-lists. Another feature's lists are edited in that feature's own settings
 * section, through the same PickListEditor.
 */
export function ListsSection() {
  return (
    <div className="flex flex-col gap-4">
      <PickListEditor
        title="Pipeline stages"
        list={CONTACT_STATUSES}
        shape="fixed"
        description="Every contact sits in one stage. The stages are fixed; rename, recolour or reorder them."
      />
      <PickListEditor title="Lead sources" list={LEAD_SOURCES} shape="open" description="Where a contact first came from." />
      <PickListEditor title="Services" list={SERVICE_TYPES} shape="open" services description="What you sell, and how often it bills." />
      <PickListEditor title="Organization types" list={ORGANIZATION_TYPES} shape="open" description="The kinds of organization a contact can belong to." />
    </div>
  );
}
