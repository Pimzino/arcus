import { useEffect, useState, type ReactNode } from "react";
import { errorMessage } from "../../lib/types";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Field } from "./Field";
import { Input } from "./Input";

export function PromptDialog({
  open,
  title,
  label,
  help,
  initialValue = "",
  placeholder,
  confirmLabel = "OK",
  selectBaseName,
  validate,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  label: ReactNode;
  help?: ReactNode;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Select the name without its extension on open (rename). */
  selectBaseName?: boolean;
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setError(null);
      setBusy(false);
    }
  }, [open, initialValue]);

  const submit = async () => {
    const problem = validate?.(value) ?? null;
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="default" onClick={submit} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-3"
      >
        <Field label={label} help={help} error={error}>
          <Input
            data-autofocus
            value={value}
            placeholder={placeholder}
            invalid={!!error}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => {
              if (selectBaseName) {
                const dot = e.target.value.lastIndexOf(".");
                e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
              } else e.target.select();
            }}
          />
        </Field>
      </form>
    </Dialog>
  );
}
