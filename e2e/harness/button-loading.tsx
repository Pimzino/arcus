// The real Button and ConfirmDialog with a switch for their loading state, for e2e/button-loading.mjs.
// window.__setLoading(true | false) flips every button at once.
import { Download, Play, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { Button, ConfirmDialog } from "../../src/components/ui";
import "../../src/index.css";

declare global {
  interface Window {
    __setLoading: (loading: boolean) => void;
  }
}

function Harness() {
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    window.__setLoading = setLoading;
  }, []);
  return (
    <div className="flex flex-col gap-4 p-6">
      {/* Each row: the button under test between two neighbours, which must not move. */}
      <Row id="default" button={<Button variant="default" loading={loading}>Save</Button>} />
      <Row id="icon" button={<Button variant="default" icon={<Download />} loading={loading}>Install</Button>} />
      <Row id="outline-sm" button={<Button size="sm" variant="default" loading={loading}>Ask for access</Button>} />
      <Row id="xs" button={<Button size="xs" variant="outline" loading={loading}>Send test</Button>} />
      <Row id="lg-icon" button={<Button size="lg" icon={<Play />} loading={loading}>Start rclone</Button>} />
      <Row id="ghost-icon" button={<Button size="sm" variant="ghost" icon={<Trash2 />} loading={loading}>Remove</Button>} />
      <ConfirmDialog
        open
        title="Delete 3 items?"
        message="This deletes them from the remote."
        confirmLabel="Delete"
        danger
        loading={loading}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />
    </div>
  );
}

function Row({ id, button }: { id: string; button: React.ReactNode }) {
  return (
    <div data-row={id} className="flex items-center gap-2">
      <span data-before className="text-sm">before</span>
      <span data-button className="contents">{button}</span>
      <span data-after className="text-sm">after</span>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Harness />);
