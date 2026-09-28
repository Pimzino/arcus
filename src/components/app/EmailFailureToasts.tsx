// Shows a toast when the backend could not send a notification email (`email:failed`). Mounted once in App.tsx.
// The email is sent after the job has ended, in the background, so without this a wrong password or a
// changed server would go unnoticed until someone missed an email.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "../ui";
import { openEmailSettings } from "../../lib/email";
import { listen } from "../../lib/tauri";

type EmailFailed = { title: string; message: string };

export function EmailFailureToasts() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<EmailFailed>("email:failed", ({ title, message }) => {
      // Settings shows the last error; it is out of date now.
      void queryClient.invalidateQueries({ queryKey: ["emailStatus"] });
      toast({
        tone: "danger",
        // Job titles often hold long paths; the toast is narrow and must not be pushed wider.
        title: <span className="line-clamp-3 wrap-anywhere">Could not send the email about “{title}”</span>,
        // The toast breaks descriptions anywhere (built for paths); a server's answer is prose, so it wraps
        // between words and only breaks a word too long for the line.
        description: <span className="[word-break:normal] wrap-anywhere">{message}</span>,
        action: { label: "Email settings", onClick: openEmailSettings },
      });
    }).then((fn) => {
      // The component can unmount before `listen` resolves (StrictMode mounts twice in development).
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient]);
  return null;
}
