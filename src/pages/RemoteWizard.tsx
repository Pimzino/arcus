// Add / edit a remote using rclone's non-interactive config state machine
// (config/create and config/update with opt.nonInteractive, continue, state, result).
//
// OAuth backends (Google Drive, OneDrive, Dropbox, Box, …) get an explicit sign-in step:
// rclone runs its local callback server, the app opens the sign-in URL in the browser
// (config/oauthstatus), and the flow can be cancelled with config/oauthstop.

import { Check, ChevronDown, ChevronRight, ChevronUp, Copy, ExternalLink, Eye, EyeOff, KeyRound, LogIn } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Callout, Card, Checkbox, Dialog, ErrorMessage, Field, Input, SearchInput, Select, Spinner, Textarea, cn, toast } from "../components/ui";
import { pluralize } from "../lib/format";
import { useProviders, type RemoteInfo } from "../lib/hooks";
import { copyToClipboard, openExternal } from "../lib/native";
import { REMOTE_NAME } from "../lib/paths";
import { rc, type ConfigOpt } from "../lib/rc";
import { errorMessage, type ConfigOut, type Provider, type RcOption } from "../lib/types";

const HIDE_CONFIGURATOR = 2;
const POPULAR = ["drive", "onedrive", "dropbox", "s3", "sftp", "box", "google cloud storage", "azureblob", "b2", "webdav", "ftp", "local", "smb", "mega", "pcloud", "crypt"];
const OAUTH_FIELDS = new Set(["token", "client_id", "client_secret"]);

function optionVisible(opt: RcOption, providerValue: string | undefined): boolean {
  if ((opt.Hide & HIDE_CONFIGURATOR) !== 0) return false;
  if (!opt.Provider) return true;
  if (!providerValue) return false;
  const negate = opt.Provider.startsWith("!");
  const list = (negate ? opt.Provider.slice(1) : opt.Provider).split(",").map((s) => s.trim());
  const listed = list.includes(providerValue);
  return negate ? !listed : listed;
}

/** Backends that authenticate with OAuth expose a `token` option next to `client_id`. */
export function usesOAuth(provider: Provider): boolean {
  const names = new Set(provider.Options.map((o) => o.Name));
  return names.has("token") && names.has("client_id");
}

/** `client_id` → "Client ID", `service_account_file` → "Service account file". */
export function friendlyLabel(name: string): string {
  const special: Record<string, string> = { id: "ID", url: "URL", api: "API", ssh: "SSH", sftp: "SFTP", ftp: "FTP", tls: "TLS", ssl: "SSL", oauth: "OAuth", acl: "ACL", sse: "SSE", kms: "KMS", uid: "UID", gid: "GID", ip: "IP", dns: "DNS", http: "HTTP", https: "HTTPS", aws: "AWS", s3: "S3", pem: "PEM", md5: "MD5", sha1: "SHA1", vfs: "VFS", cpu: "CPU" };
  return name
    .split("_")
    .map((w, i) => (special[w] ? special[w] : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function HelpText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return (
    <span className={cn("whitespace-pre-line", className)}>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a
            key={i}
            href={part}
            className="text-primary hover:underline"
            onClick={(e) => {
              e.preventDefault();
              void openExternal(part);
            }}
          >
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}

/** Help shown under a field: first sentence, expandable to the full text. */
function OptionHelp({ text }: { text: string }) {
  const [more, setMore] = useState(false);
  const firstLine = text.split("\n")[0].trim();
  const rest = text.slice(firstLine.length).trim();
  return (
    <span>
      <HelpText text={more && rest ? text : firstLine} />
      {rest && (
        <button type="button" className="no-ring ml-1 text-primary hover:underline" onClick={() => setMore((m) => !m)}>
          {more ? "less" : "more"}
        </button>
      )}
    </span>
  );
}

/** A single config option input driven by rclone's option metadata. */
export function OptionInput({ option, value, onChange, invalid, autoFocus }: { option: RcOption; value: string; onChange: (value: string) => void; invalid?: boolean; autoFocus?: boolean }) {
  const [reveal, setReveal] = useState(false);
  const [custom, setCustom] = useState(false);
  const examples = option.Examples ?? [];
  const isBool = option.Type === "bool";

  if (option.IsPassword) {
    return (
      <Input
        type={reveal ? "text" : "password"}
        value={value}
        invalid={invalid}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={option.Required ? "Required" : "Leave blank to keep the default"}
        autoComplete="off"
        trailing={
          <button type="button" className="no-ring rounded-md p-0.5 hover:bg-muted hover:text-foreground" aria-label={reveal ? "Hide" : "Show"} onClick={() => setReveal((r) => !r)}>
            {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        }
      />
    );
  }

  if (isBool && examples.length === 0) {
    return (
      <Select value={value} invalid={invalid} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus}>
        <option value="">Default ({option.DefaultStr || "false"})</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </Select>
    );
  }

  if (examples.length > 0 && !custom) {
    const known = examples.some((ex) => ex.Value === value);
    return (
      <Select
        value={known || value === "" ? value : "__custom__"}
        invalid={invalid}
        autoFocus={autoFocus}
        onChange={(e) => {
          if (e.target.value === "__custom__") {
            setCustom(true);
            onChange("");
          } else onChange(e.target.value);
        }}
      >
        <option value="">Default{option.DefaultStr ? ` (${option.DefaultStr})` : ""}</option>
        {examples.map((ex) => (
          <option key={ex.Value} value={ex.Value}>
            {ex.Value || "(empty)"}
            {ex.Help ? ` — ${ex.Help.split("\n")[0]}` : ""}
          </option>
        ))}
        {!option.Exclusive && !isBool && <option value="__custom__">Other value…</option>}
      </Select>
    );
  }

  return (
    <Input
      value={value}
      invalid={invalid}
      autoFocus={autoFocus}
      mono={/url|path|file|id|key|endpoint|host/i.test(option.Name)}
      onChange={(e) => onChange(e.target.value)}
      placeholder={option.DefaultStr ? `Default: ${option.DefaultStr}` : option.Required ? "Required" : ""}
    />
  );
}

/** Choice list for a question whose answers are fixed (e.g. yes/no, provider lists). */
function ChoiceList({ option, value, onChange }: { option: RcOption; value: string; onChange: (v: string) => void }) {
  const examples = option.Examples ?? [];
  return (
    <div role="radiogroup" className="flex flex-col gap-1.5">
      {examples.map((ex) => {
        const active = value === ex.Value;
        return (
          <button
            key={ex.Value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(ex.Value)}
            className={cn(
              "no-ring flex items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
              active ? "border-primary bg-primary/10" : "border-border hover:bg-muted",
            )}
          >
            <span className={cn("mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border", active ? "border-primary bg-primary text-primary-foreground" : "border-input")}>
              {active && <Check className="size-3" />}
            </span>
            <span className="min-w-0">
              <span className="block font-medium">{ex.Help?.split("\n")[0] || ex.Value || "(empty)"}</span>
              {ex.Help && <span className="block font-mono text-xs text-muted-foreground">{ex.Value}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function OptionField({ option, value, onChange, error }: { option: RcOption; value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <Field
      label={
        <span className="inline-flex items-center gap-2">
          {friendlyLabel(option.Name)}
          <span className="font-mono text-xs font-normal text-muted-foreground">{option.Name}</span>
          {option.Sensitive && (
            <Badge size="sm" tone="warning">
              sensitive
            </Badge>
          )}
        </span>
      }
      required={option.Required && !option.DefaultStr}
      help={<OptionHelp text={option.Help} />}
      error={error}
    >
      {option.Name === "token" ? (
        <Textarea mono rows={3} invalid={!!error} value={value} onChange={(e) => onChange(e.target.value)} placeholder='{"access_token": "…", "token_type": "Bearer", "refresh_token": "…", "expiry": "…"}' />
      ) : (
        <OptionInput option={option} value={value} onChange={onChange} invalid={!!error} />
      )}
    </Field>
  );
}

type Step = "provider" | "form" | "question" | "oauth";
type AuthMode = "browser" | "token";
/** Which control a failed check belongs to, so the message lands under it. */
type Invalid = { field: "name" | "token" | "options"; message: string };

export function RemoteWizard({ mode, remote, onClose, onSaved }: { mode: "create" | "edit"; remote?: RemoteInfo; onClose: () => void; onSaved: (name: string) => void }) {
  const providers = useProviders();
  const [step, setStep] = useState<Step>(mode === "create" ? "provider" : "form");
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState<Provider | null>(null);
  const [name, setName] = useState(remote?.name ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const [initial, setInitial] = useState<Record<string, string>>({});
  const [authMode, setAuthMode] = useState<AuthMode>("browser");
  const [showOwnApp, setShowOwnApp] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Invalid | null>(null);
  const [question, setQuestion] = useState<ConfigOut | null>(null);
  const [answer, setAnswer] = useState("");
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const openedRef = useRef(false);

  useEffect(() => {
    if (mode !== "edit" || !remote || !providers.data) return;
    const p = providers.data.find((x) => x.Name === remote.type || x.Aliases?.includes(remote.type));
    setProvider(p ?? null);
    const loaded: Record<string, string> = {};
    for (const [k, v] of Object.entries(remote.config)) if (k !== "type") loaded[k] = v;
    setValues(loaded);
    setInitial(loaded);
    if (loaded.client_id) setShowOwnApp(true);
  }, [mode, remote, providers.data]);

  useEffect(() => () => stopPolling(), []);

  const oauth = !!provider && usesOAuth(provider);

  const filteredProviders = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = providers.data ?? [];
    const matches = all.filter((p) => !q || p.Name.toLowerCase().includes(q) || p.Description.toLowerCase().includes(q));
    if (q) return { popular: [], rest: matches };
    const popular = POPULAR.map((n) => all.find((p) => p.Name === n)).filter((p): p is Provider => !!p);
    return { popular, rest: matches.filter((p) => !popular.includes(p)) };
  }, [providers.data, search]);

  const visibleOptions = useMemo(() => (provider ? provider.Options.filter((o) => optionVisible(o, values.provider)) : []), [provider, values.provider]);
  const standard = visibleOptions.filter((o) => !o.Advanced && !(oauth && OAUTH_FIELDS.has(o.Name)));
  const advanced = visibleOptions.filter((o) => o.Advanced && !(oauth && OAUTH_FIELDS.has(o.Name)));
  const oauthFields = oauth ? visibleOptions.filter((o) => OAUTH_FIELDS.has(o.Name)) : [];
  const ownAppFields = oauthFields.filter((o) => o.Name !== "token");
  const tokenField = oauthFields.find((o) => o.Name === "token");

  const setValue = (key: string, v: string) => setValues((s) => ({ ...s, [key]: v }));
  const fieldError = (field: Invalid["field"]) => (invalid?.field === field ? invalid.message : undefined);

  const parameters = () => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (mode === "edit" && initial[k] === v) continue;
      if (v === "" && mode === "create") continue;
      if (oauth && authMode === "browser" && k === "token") continue;
      out[k] = v;
    }
    // Ephemeral (never stored): the app opens the browser itself so it can show the link too.
    if (oauth && authMode === "browser") out.config_auth_no_browser = "true";
    return out;
  };

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };

  const startPolling = () => {
    stopPolling();
    openedRef.current = false;
    setAuthUrl(null);
    pollRef.current = setInterval(async () => {
      try {
        const status = await rc.oauthStatus();
        if (status.status === "running" && status.authUrl) {
          setAuthUrl(status.authUrl);
          if (!openedRef.current) {
            openedRef.current = true;
            void openExternal(status.authUrl);
          }
        }
      } catch {
        /* daemon busy; keep polling */
      }
    }, 600);
  };

  const handleOut = (out: ConfigOut) => {
    stopPolling();
    if (out.State === "") {
      if (out.Error) {
        setError(out.Error);
        setStep("form");
        return;
      }
      onSaved(name.trim());
      return;
    }
    if (!out.Option) {
      void continueWith(out.State, out.Result ?? "");
      return;
    }
    // This computer has a browser: answer rclone's "use web browser?" question ourselves.
    if (out.Option.Name === "config_is_local" && authMode === "browser") {
      void continueWith(out.State, "true");
      return;
    }
    setQuestion(out);
    setAnswer(out.Option.Name === "config_shared_client_id" ? "true" : (out.Option.DefaultStr ?? ""));
    setStep("question");
  };

  const callConfig = async (opt: ConfigOpt) => {
    const base: ConfigOpt = { nonInteractive: true, obscure: true, ...opt };
    if (mode === "create") {
      setCreated(true);
      return rc.configCreate(name.trim(), provider!.Name, parameters(), base);
    }
    return rc.configUpdate(name.trim(), parameters(), base);
  };

  const submitForm = async () => {
    setError(null);
    setInvalid(null);
    if (!name.trim() || !REMOTE_NAME.test(name.trim())) {
      setInvalid({ field: "name", message: "Remote names may contain letters, digits, spaces and _ - . + @, and cannot start with - or a space." });
      return;
    }
    const missing = standard.filter((o) => o.Required && !values[o.Name] && !o.DefaultStr && mode === "create");
    if (missing.length) {
      setInvalid({ field: "options", message: `Please fill in: ${missing.map((o) => friendlyLabel(o.Name)).join(", ")}` });
      return;
    }
    if (oauth && authMode === "token" && mode === "create" && !values.token?.trim()) {
      setInvalid({ field: "token", message: "Paste the OAuth token, or choose “Sign in with your browser”." });
      return;
    }
    setBusy(true);
    try {
      handleOut(await callConfig({}));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const continueWith = async (state: string, result: string) => {
    setBusy(true);
    setError(null);
    const signingIn = /\*oauth-islocal/.test(state) && result === "true";
    if (signingIn) {
      setStep("oauth");
      startPolling();
    }
    try {
      handleOut(await callConfig({ continue: true, state, result }));
    } catch (e) {
      stopPolling();
      const message = errorMessage(e);
      setError(/cancelled/i.test(message) ? "Sign-in was cancelled." : message);
      setStep("form");
    } finally {
      setBusy(false);
    }
  };

  /** Cancel mid-flow: stop a pending sign-in and remove a half-created remote. */
  const cancelFlow = async () => {
    stopPolling();
    if (step === "oauth") await rc.oauthStop().catch(() => undefined);
    if (mode === "create" && created) {
      await rc.configDelete(name.trim()).catch(() => undefined);
    }
    onClose();
  };

  const closeDialog = () => {
    if (step === "question" || step === "oauth") void cancelFlow();
    else onClose();
  };

  const title = mode === "create" ? (provider ? `Add remote · ${provider.Description}` : "Add remote") : `Edit ${remote?.name}:`;
  const description =
    step === "provider"
      ? "Choose the kind of storage to connect."
      : step === "form"
        ? oauth
          ? "Name the remote and choose how to authorise it."
          : "Fill in what rclone needs; defaults are fine for most options."
        : step === "oauth"
          ? "Finish signing in with your browser."
          : "rclone needs one more answer.";

  const ProviderRow = ({ p }: { p: Provider }) => (
    <button
      key={p.Name}
      type="button"
      className={cn(
        "no-ring flex w-full items-center gap-3 px-3 py-2 text-sm hover:bg-muted focus-visible:bg-muted",
        provider?.Name === p.Name && "bg-muted",
      )}
      onClick={() => {
        setProvider(p);
        setValues({});
        setAuthMode("browser");
        setInvalid(null);
        setStep("form");
      }}
    >
      <span className="min-w-0 flex-1 truncate text-left font-medium" title={p.Description}>
        {p.Description}
      </span>
      {usesOAuth(p) && <span className="shrink-0 text-xs text-muted-foreground">sign in with browser</span>}
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{p.Name}</span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );

  const primaryLabel =
    mode === "edit" ? "Save changes" : oauth && authMode === "browser" ? `Continue to ${provider?.Description ?? "sign in"}` : "Create remote";

  return (
    <Dialog
      open
      onClose={closeDialog}
      title={title}
      description={description}
      size="lg"
      footer={
        step === "provider" ? (
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        ) : step === "form" ? (
          <>
            {mode === "create" && (
              <Button variant="outline" onClick={() => setStep("provider")} className="mr-auto">
                Back
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="default" loading={busy} icon={oauth && authMode === "browser" && mode === "create" ? <LogIn /> : undefined} onClick={submitForm}>
              {primaryLabel}
            </Button>
          </>
        ) : step === "oauth" ? (
          <Button variant="ghost" onClick={cancelFlow}>
            Cancel sign-in
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={cancelFlow} disabled={busy}>
              Cancel
            </Button>
            <Button variant="default" loading={busy} onClick={() => continueWith(question!.State, answer)}>
              Continue
            </Button>
          </>
        )
      }
    >
      {step === "provider" && (
        // The dialog body is padded; the searchable list spans the whole dialog like the reference.
        <div className="-mx-6 -mb-4 flex h-[520px] flex-col">
          <div className="px-6 pb-3">
            <SearchInput autoFocus value={search} onValueChange={setSearch} placeholder="Search storage providers…" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-none border-t px-3 py-2">
            {providers.isLoading && (
              <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                <Spinner /> Loading providers…
              </div>
            )}
            {filteredProviders.popular.length > 0 && (
              <>
                <div className="px-3 pt-1 pb-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">Popular</div>
                {filteredProviders.popular.map((p) => (
                  <ProviderRow key={p.Name} p={p} />
                ))}
                <div className="px-3 pt-3 pb-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">All providers</div>
              </>
            )}
            {filteredProviders.rest.map((p) => (
              <ProviderRow key={p.Name} p={p} />
            ))}
            {!providers.isLoading && filteredProviders.rest.length === 0 && filteredProviders.popular.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">No provider matches “{search}”.</div>
            )}
          </div>
        </div>
      )}

      {step === "form" && provider && (
        <div className="flex flex-col gap-4">
          {error && <ErrorMessage error={error} onDismiss={() => setError(null)} />}

          <Card
            title="Remote"
            description={
              <>
                {provider.Description} <span className="font-mono text-xs">{provider.Name}</span>
              </>
            }
          >
            <Field label="Remote name" required help="Used as the prefix in paths, e.g. name:folder/file" error={fieldError("name")}>
              <Input
                mono
                value={name}
                invalid={!!fieldError("name")}
                disabled={mode === "edit"}
                autoFocus={mode === "create"}
                onChange={(e) => setName(e.target.value)}
                placeholder={provider.Name}
              />
            </Field>
          </Card>

          {oauth && (
            <Card title="Authorisation" description={`How rclone gets access to your ${provider.Description} account.`}>
              <div className="flex flex-col gap-4">
                <div role="radiogroup" className="grid grid-cols-2 gap-3">
                  <AuthCard
                    active={authMode === "browser"}
                    icon={<LogIn className="size-4" />}
                    title="Sign in with your browser"
                    badge="Recommended"
                    description={`Opens ${provider.Description}'s sign-in page. rclone receives the authorisation on this computer and stores the token in your rclone config.`}
                    onClick={() => setAuthMode("browser")}
                  />
                  <AuthCard
                    active={authMode === "token"}
                    icon={<KeyRound className="size-4" />}
                    title="Paste an existing token"
                    description="Use a token JSON obtained elsewhere, for example with rclone authorize on another machine."
                    onClick={() => setAuthMode("token")}
                  />
                </div>
                {authMode === "token" && tokenField && (
                  <OptionField option={tokenField} value={values.token ?? ""} onChange={(v) => setValue("token", v)} error={fieldError("token")} />
                )}
                {mode === "edit" && authMode === "browser" && (
                  <p className="text-sm text-muted-foreground">If this remote already has a token, rclone will ask whether to replace it after you save.</p>
                )}
                {ownAppFields.length > 0 && (
                  <div className="border">
                    <Checkbox
                      className="px-3 py-2.5"
                      label="Use my own OAuth app (client ID and secret)"
                      description={
                        provider.Name === "drive"
                          ? "Optional. Google is retiring rclone's shared client ID during 2026, so creating your own is recommended for Google Drive."
                          : "Optional. Leave off to use rclone's shared app registration."
                      }
                      checked={showOwnApp}
                      onChange={setShowOwnApp}
                    />
                    {showOwnApp && (
                      <div className="flex flex-col gap-4 border-t px-3 py-3">
                        {ownAppFields.map((o) => (
                          <OptionField key={o.Name} option={o} value={values[o.Name] ?? ""} onChange={(v) => setValue(o.Name, v)} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </Card>
          )}

          {standard.length > 0 && (
            <Card title="Standard options" description="What rclone asks for when you configure this backend.">
              <div className="flex flex-col gap-5">
                {standard.map((o) => (
                  <OptionField key={o.Name} option={o} value={values[o.Name] ?? ""} onChange={(v) => setValue(o.Name, v)} />
                ))}
                {fieldError("options") && <p className="text-sm text-destructive">{fieldError("options")}</p>}
              </div>
            </Card>
          )}

          {advanced.length > 0 && (
            <Card title="Advanced options" description="Extra settings for this backend. The defaults are right for most remotes.">
              <div className="flex flex-col gap-4">
                <Button variant="ghost" className="self-start" icon={showAdvanced ? <ChevronUp /> : <ChevronDown />} onClick={() => setShowAdvanced((v) => !v)}>
                  {showAdvanced ? "Hide" : "Show"} {pluralize(advanced.length, "option")}
                </Button>
                {showAdvanced && (
                  <div className="flex flex-col gap-5">
                    {advanced.map((o) => (
                      <OptionField key={o.Name} option={o} value={values[o.Name] ?? ""} onChange={(v) => setValue(o.Name, v)} />
                    ))}
                  </div>
                )}
              </div>
            </Card>
          )}

          {!oauth && <p className="text-sm text-muted-foreground">rclone may ask follow-up questions after saving.</p>}
        </div>
      )}

      {step === "question" && question?.Option && (
        <div className="flex flex-col gap-4">
          {question.Error && <ErrorMessage error={question.Error} />}
          {error && <ErrorMessage error={error} onDismiss={() => setError(null)} />}
          <Field
            label={
              <span className="inline-flex items-center gap-2">
                {friendlyLabel(question.Option.Name.replace(/^config_/, ""))}
                <span className="font-mono text-xs font-normal text-muted-foreground">{question.Option.Name}</span>
              </span>
            }
            help={<HelpText text={question.Option.Help} />}
            required={question.Option.Required}
          >
            {question.Option.Exclusive && (question.Option.Examples?.length ?? 0) > 0 && (question.Option.Examples?.length ?? 0) <= 8 ? (
              <ChoiceList option={question.Option} value={answer} onChange={setAnswer} />
            ) : (
              <OptionInput option={question.Option} value={answer} onChange={setAnswer} autoFocus />
            )}
          </Field>
        </div>
      )}

      {step === "oauth" && (
        <div className="flex flex-col gap-4">
          {error && <ErrorMessage error={error} onDismiss={() => setError(null)} />}
          <Callout tone="info" title={`Waiting for you to sign in to ${provider?.Description}…`}>
            <div className="flex flex-col gap-3">
              <span className="flex items-center gap-2">
                <Spinner />
                {authUrl ? "Your browser should have opened the sign-in page. Approve access for rclone; this dialog continues automatically." : "Starting rclone's sign-in helper…"}
              </span>
              {authUrl && (
                <>
                  <div>
                    <div className="mb-1 text-sm text-muted-foreground">If the browser did not open, use this link:</div>
                    <div className="selectable break-all bg-muted px-3 py-2 font-mono text-xs">{authUrl}</div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" icon={<ExternalLink />} onClick={() => openExternal(authUrl)}>
                      Open browser
                    </Button>
                    <Button variant="outline" icon={<Copy />} onClick={() => copyToClipboard(authUrl).then(() => toast({ tone: "success", title: "Link copied" }))}>
                      Copy link
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    The link points at rclone's local helper on this computer, which forwards you to the provider's sign-in page and receives the result.
                  </p>
                </>
              )}
            </div>
          </Callout>
        </div>
      )}
    </Dialog>
  );
}

function AuthCard({
  active,
  icon,
  title,
  badge,
  description,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  badge?: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "no-ring flex flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
        active ? "border-primary bg-primary/10" : "border-border hover:bg-muted",
      )}
    >
      <span className="flex items-center gap-2 font-medium">
        <span className={cn(active ? "text-primary" : "text-muted-foreground")}>{icon}</span>
        {title}
        {badge && (
          <Badge size="sm" tone="accent">
            {badge}
          </Badge>
        )}
      </span>
      <span className="text-sm text-muted-foreground">{description}</span>
    </button>
  );
}
