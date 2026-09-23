import { ArrowRight } from "lucide-react";
import { MacPermissionsList } from "../components/app/MacPermissions";
import { Button, Card, PageBody, PageHeader } from "../components/ui";
import { useAppStore } from "../store/app";

/** First-run guide to the macOS permissions the app uses; Settings keeps the same checklist afterwards. */
export function PermissionsPage() {
  const markReviewed = useAppStore((s) => s.markMacPermissionsReviewed);
  return (
    <>
      <PageHeader title="Permissions" description="macOS protects some folders and features. Set up the ones Arcus uses now, or come back to this later." />
      <PageBody>
        <div className="mx-auto flex max-w-2xl flex-col gap-6">
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
