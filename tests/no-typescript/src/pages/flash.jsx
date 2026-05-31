import { Flash } from "../components/Flash.jsx";

export function FlashPage() {
  return (
    <div data-testid="flash-page">
      <h1 data-testid="flash-title">Action Location State</h1>
      <p>A server action writes location state that is read on the client.</p>
      <Flash />
    </div>
  );
}
