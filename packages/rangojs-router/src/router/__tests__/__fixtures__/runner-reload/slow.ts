// Holds the re-created router's module before it registers, once the test
// asks for it (the reload's re-import of a large entry).
const state = globalThis as { __rangoRunnerReloadSlow?: { started: boolean } };
if (state.__rangoRunnerReloadSlow) {
  state.__rangoRunnerReloadSlow.started = true;
  await new Promise((resolve) => setTimeout(resolve, 300));
}
export {};
