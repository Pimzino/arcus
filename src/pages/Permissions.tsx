import { ArrowRight } from "lucide-react";
import { MacPermissionsList } from "../components/app/MacPermissions";
import { Button, Callout, Card, PageBody, PageHeader } from "../components/ui";
import { useAppStore } from "../store/app";

/**
 * The macOS permissions guide. It comes first on a new install, before the explorer lists a folder, and once more if
 * macOS forgets Arcus's permissions; Settings keeps the same checklist afterwards.
 */
export function PermissionsPage() {
  const markReviewed = useAppStore((s) => s.markMacPermissionsReviewed);
  const forgotten = useAppStore((s) => s.macPermissions.forgotten);
  return (
    <>
      <PageHeader
        title="Permissions"
        description="macOS protects some folders and features. Allow the ones Arcus uses now, so no prompt interrupts a transfer later, or come back to this under Settings."
      />
      <PageBody>
        <div className="mx-auto flex max-w-2xl flex-col gap-6">
          {forgotten && (
            <Callout tone="warning" title="macOS no longer recognises Arcus">
              This copy of Arcus is signed differently from the one you gave permissions to, so macOS has reset them. Allow
              them again below.
            </Callout>
          )}
          <Card>
            <MacPermissionsList />
          </Card>
          <div className="flex items-center justify-end gap-4">
            <span className="text-sm text-muted-foreground">This checklist stays available under Settings → macOS permissions.</span>
            <Button variant="default" size="lg" iconRight={<ArrowRight />} onClick={() => void markReviewed()}>
              Continue
            </Button>
          </div>
        </div>
      </PageBody>
    </>
  );
}
