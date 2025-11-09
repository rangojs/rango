import {
  getTestPageStats,
  incrementTestPageVisits,
  addMessage,
  getMessages,
  clearMessages,
  performServerCalculation,
} from "./myTestActions.tsx";
import { TempAwaitText } from "./components/tempAwaitText.tsx";
import { Partial } from "./components/partial.server.tsx";
import { startTransition, useActionState } from "react";
import { ServerCounterClient } from "./components/server-counter.client.tsx";
import { getServerCounter } from "./action.tsx";
import { Storage } from "./framework/entry.storage.ts";
import style from "./MyTestPage.module.css";
// This is a dedicated RSC component for the /my-test route
export async function MyTestPage() {
  // Increment visit counter on page load
  await incrementTestPageVisits();
  const _pending = new Promise<string>((res) =>
    setTimeout(() => res("resolved at server"), 6000)
  ); // simulate delay
  // Get current stats and messages
  const stats = await getTestPageStats();
  const messages = await getMessages();

  // Simulate fetching specific data for this route
  const timestamp = new Date().toISOString();

  // You can fetch any data here - database queries, API calls, etc.
  const testData = {
    pageTitle: "My Test Page with Server Actions",
    content:
      "This is RSC content loaded from /my-test path with server actions!",
    timestamp,
    features: [
      "Loaded via dynamic routing",
      "Server-side rendered",
      "Server actions for state management",
      "Direct server-side calculations",
    ],
    randomNumber: Math.floor(Math.random() * 1000),
  };
  // const [state, submitAction, isPending] = useActionState(
  //   incrementTestPageVisits,
  //   {
  //     error: null,
  //   }
  // );
  // console.log("state", { state, submitAction, isPending });

  return (
    <div className={`${style["my-test-page"]}`}>
      <h1>{testData.pageTitle}</h1>
      <TempAwaitText promise={_pending} />
      <ServerCounterClient>
        Server Counter: {getServerCounter()}
      </ServerCounterClient>
      <p className="test-content">{testData.content}</p>
      Page Visit Stats
      <div className="stats-section">
        <h3>📊 Page Statistics (Server State)</h3>
        <p>
          Total Visits: <strong>{stats.visits}</strong>
        </p>
        <p>
          Last Visitor: <strong>{stats.lastVisitor}</strong>
        </p>
        <p>
          Messages: <strong>{stats.messageCount}</strong>
        </p>

        <form
          action={async () => {
            "use server";
            const result = await incrementTestPageVisits(`User-${Date.now()}`);
            console.log("result", result);
          }}
        >
          <button type="submit">👋 Record My Visit</button>
        </form>
      </div>
      {/* Message Board */}
      <div className="message-section">
        <h3>💬 Server Message Board</h3>

        <form
          action={async (formData: FormData) => {
            "use server";
            const message = formData.get("message") as string;
            if (message) {
              await addMessage(message);
            }
          }}
        >
          <input
            name="message"
            type="text"
            placeholder="Type a message..."
            required
            className="message-input"
          />
          <button type="submit">Send Message</button>
        </form>

        <div className="messages-list">
          {messages.length > 0 ? (
            <>
              <h4>Recent Messages:</h4>
              <ul>
                {messages.map((msg, idx) => (
                  <li key={idx}>{msg}</li>
                ))}
              </ul>
              <form>
                <button type="submit" className="clear-btn">
                  🗑️ Clear Messages
                </button>
              </form>
            </>
          ) : (
            <p>No messages yet. Be the first!</p>
          )}
        </div>
      </div>
      {/* Server Calculation */}
      <div className="calculation-section">
        <h3>🧮 Server-Side Calculator</h3>

        <form
          action={async (formData: FormData) => {
            "use server";
            const num1 = parseFloat(formData.get("num1") as string);
            const num2 = parseFloat(formData.get("num2") as string);
            const operation = formData.get("operation") as string;
            const result = await performServerCalculation(
              num1,
              num2,
              operation
            );
            // In a real app, you'd store this result and display it
            console.log("Calculation result:", result);
          }}
        >
          <div className="calc-inputs">
            <input
              name="num1"
              type="number"
              placeholder="Number 1"
              defaultValue="10"
              required
            />
            <select name="operation" defaultValue="add">
              <option value="add">+</option>
              <option value="multiply">×</option>
              <option value="power">^</option>
            </select>
            <input
              name="num2"
              type="number"
              placeholder="Number 2"
              defaultValue="5"
              required
            />
            <button type="submit">Calculate on Server</button>
          </div>
        </form>
      </div>
      <div className="test-info">
        <p>
          <strong>Rendered at:</strong> {testData.timestamp}
        </p>
        <p>
          <strong>Random Number:</strong> {testData.randomNumber}
        </p>

        <h3>Features:</h3>
        <ul>
          {testData.features.map((feature, index) => (
            <li key={index}>✨ {feature}</li>
          ))}
        </ul>
      </div>
      <div className="navigation">
        <a href="/">← Back to Home</a>
      </div>
    </div>
  );
}
