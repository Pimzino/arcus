import { useAppStore } from "../store/app";
import { invoke } from "./tauri";

/**
 * Steps an end-to-end test has the page perform by itself (`ARCUS_E2E_UI`, read by the debug-only hooks in
 * src-tauri e2e.rs), since nobody can click in the built app. A release build hands out no steps, so this does
 * nothing there.
 *
 * - `{ "wait": ms }`
 * - `{ "waitFor": "text", "timeoutMs"?: ms }`: until the page shows the text
 * - `{ "click": "Button label", "within"?: "text of the button's section" }`
 * - `{ "report": "name" }`: the page shown, its text and the stored permissions progress, to the report file
 */
type Step =
  | { wait: number }
  | { waitFor: string; timeoutMs?: number }
  | { click: string; within?: string }
  | { report: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mainText = () => (document.querySelector("main") as HTMLElement | null)?.innerText ?? document.body.innerText;
const report = (entry: Record<string, unknown>) => invoke("e2e_ui_report", { entry }).catch(() => undefined);

/** The first enabled button labelled `label`, inside the smallest element that also contains `within`. */
function findButton(label: string, within?: string): HTMLButtonElement | null {
  const buttons = [...document.querySelectorAll("button")].filter((b) => b.innerText.trim() === label && !b.disabled);
  if (!within) return buttons[0] ?? null;
  for (const button of buttons) {
    for (let el: HTMLElement | null = button.parentElement; el; el = el.parentElement) {
      if (el.innerText.includes(within)) {
        // The section is the smallest ancestor holding the text: stop there, or every button would match.
        const others = [...el.querySelectorAll("button")].filter((b) => b.innerText.trim() === label);
        if (others.length === 1) return button;
        break;
      }
    }
  }
  return null;
}

export async function runE2eSteps() {
  const steps = await invoke<Step[] | null>("e2e_ui_steps").catch(() => null);
  if (!steps?.length) return;
  for (const [index, step] of steps.entries()) {
    try {
      if ("wait" in step) {
        await sleep(step.wait);
      } else if ("waitFor" in step) {
        const end = Date.now() + (step.timeoutMs ?? 20_000);
        while (!mainText().includes(step.waitFor)) {
          if (Date.now() > end) throw new Error(`"${step.waitFor}" never showed`);
          await sleep(100);
        }
      } else if ("click" in step) {
        const button = findButton(step.click, step.within);
        if (!button) throw new Error(`no button "${step.click}"${step.within ? ` in "${step.within}"` : ""}`);
        button.click();
      } else if ("report" in step) {
        const { page, macPermissions } = useAppStore.getState();
        await report({ report: step.report, page, macPermissions, text: mainText().slice(0, 6000) });
        continue;
      }
      await report({ step: index, done: step });
    } catch (e) {
      await report({ step: index, failed: step, error: String(e) });
      return;
    }
  }
}
