import { ActionLocationStateTest } from "../components/ActionLocationStateTest.js";
import { RouterPushStateTest } from "../components/RouterPushStateTest.js";

export function ActionLocationStatePage() {
  return (
    <main data-testid="action-location-state-page">
      <h1>Action Location State Test</h1>
      <ActionLocationStateTest />
      <RouterPushStateTest />
    </main>
  );
}
