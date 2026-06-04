import { Counter } from "../components/Counter.jsx";
import { getCounter } from "../actions.js";

// Server component: reads the initial count from the server, then hands it to
// the client Counter which mutates it via server actions.
export async function CounterPage() {
  const initialCount = await getCounter();
  return (
    <div data-testid="counter-page">
      <h1 data-testid="counter-title">Counter</h1>
      <p>Server actions mutate an in-memory counter.</p>
      <Counter initialCount={initialCount} />
    </div>
  );
}
