import { type CliRenderer, createCliRenderer } from "@opentui/core";

/**
 * useMouse: true so the scroll wheel reaches the transcript and OpenTUI
 * receives drag events for in-app text selection. Bare Ctrl+C is the
 * always-exit keystroke (via exitOnCtrlC) so the convention every other
 * interactive Linux/Windows terminal app follows still works here.
 *
 * Tests inject a `createTestRenderer` instance via `input.renderer`; in
 * that mode we skip the production renderer construction and the
 * `globalThis.window` restore that wraps it (the test renderer never
 * installs the shim).
 */
export async function acquireRenderer(injected?: CliRenderer): Promise<CliRenderer> {
  if (injected) return injected;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useMouse: true,
    useKittyKeyboard: {},
    targetFps: 60,
  });
  restoreWindowGlobal(previousWindow);
  return renderer;
}

/**
 * Resolves when the renderer emits its `destroy` event, running the supplied
 * teardown hook synchronously inside the event listener so chrome writers can
 * flip into a stopped state before the rest of `runTui` returns.
 */
export function waitForRendererDestroy(
  renderer: CliRenderer,
  onDestroy: () => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    renderer.once("destroy", () => {
      onDestroy();
      resolve();
    });
  });
}

function restoreWindowGlobal(previousWindow: PropertyDescriptor | undefined): void {
  // OpenTUI installs `window.requestAnimationFrame` for browser-style
  // animation compatibility. In Bun, the presence of `window` can send fetch
  // internals down browser-only paths, while `global.requestAnimationFrame`
  // remains enough for OpenTUI after initialization.
  if (previousWindow) {
    Object.defineProperty(globalThis, "window", previousWindow);
    return;
  }
  delete (globalThis as typeof globalThis & { window?: unknown }).window;
}
