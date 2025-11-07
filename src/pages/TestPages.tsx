/**
 * Test page components for experimenting with the declarative router
 */

import { type RouteContext } from "rsc-router";

// Counter to show when components re-render
let renderCount = {
  home: 0,
  list: 0,
  detail: 0,
};

export function TestHomePage() {
  renderCount.home++;
  return (
    <div style={{ padding: "20px" }}>
      <h1>🧪 Test Home Page</h1>
      <p>Welcome to the declarative router test environment!</p>
      <p style={{ color: "green" }}>
        Render count: {renderCount.home} (shows when component re-renders)
      </p>

      <h2>Try these features:</h2>
      <ul>
        <li>Navigate between pages and watch render counts</li>
        <li>Test layouts that persist across navigation</li>
        <li>Dynamic route parameters</li>
        <li>Nested routing structures</li>
      </ul>

      <nav style={{ marginTop: "20px" }}>
        <a href="/test/items" style={{ marginRight: "10px" }}>
          Go to Item List →
        </a>
        <a href="/test/counter">Counter Example →</a>
      </nav>
    </div>
  );
}

export function TestItemList() {
  renderCount.list++;
  const items = [
    { id: "1", name: "Apple", emoji: "🍎" },
    { id: "2", name: "Banana", emoji: "🍌" },
    { id: "3", name: "Cherry", emoji: "🍒" },
  ];

  return (
    <div style={{ padding: "20px" }}>
      <h2>📋 Item List</h2>
      <p style={{ color: "green" }}>Render count: {renderCount.list}</p>

      <ul>
        {items.map((item) => (
          <li key={item.id} style={{ marginBottom: "10px" }}>
            <a href={`/test/items/${item.id}`}>
              {item.emoji} {item.name} →
            </a>
          </li>
        ))}
      </ul>

      <a href="/">← Back to Home</a>
    </div>
  );
}

export function TestItemDetail({ id }: { id: string }) {
  renderCount.detail++;

  const items: Record<
    string,
    { name: string; emoji: string; description: string }
  > = {
    "1": {
      name: "Apple",
      emoji: "🍎",
      description: "A crisp and sweet fruit, perfect for snacking.",
    },
    "2": {
      name: "Banana",
      emoji: "🍌",
      description: "Rich in potassium and great for energy.",
    },
    "3": {
      name: "Cherry",
      emoji: "🍒",
      description: "Small, sweet, and perfect for desserts.",
    },
  };

  const item = items[id] || {
    name: "Unknown",
    emoji: "❓",
    description: "Item not found!",
  };

  return (
    <div style={{ padding: "20px" }}>
      <h2>
        {item.emoji} {item.name}
      </h2>
      <p style={{ color: "green" }}>
        Render count: {renderCount.detail} | Item ID: {id}
      </p>

      <p>{item.description}</p>

      <div style={{ marginTop: "20px" }}>
        <h3>Try navigating between items:</h3>
        <nav>
          <a href="/test/items/1" style={{ marginRight: "10px" }}>
            🍎 Apple
          </a>
          <a href="/test/items/2" style={{ marginRight: "10px" }}>
            🍌 Banana
          </a>
          <a href="/test/items/3" style={{ marginRight: "10px" }}>
            🍒 Cherry
          </a>
        </nav>
      </div>

      <div style={{ marginTop: "20px" }}>
        <a href="/test/items">← Back to List</a>
      </div>
    </div>
  );
}

// A simple counter component to test state and revalidation
export function TestCounter() {
  // Note: This is server-side, so state won't persist between renders
  // This is just to demonstrate the concept
  const timestamp = new Date().toLocaleTimeString();

  return (
    <div style={{ padding: "20px" }}>
      <h2>⏱️ Server Time Counter</h2>
      <p>
        Current server time: <strong>{timestamp}</strong>
      </p>
      <p>
        This updates on each navigation to show when the server component
        re-renders.
      </p>

      <div style={{ marginTop: "20px" }}>
        <button onClick={() => window.location.reload()}>Refresh Page</button>
        <a href="/test/counter" style={{ marginLeft: "10px" }}>
          Navigate to Same Page
        </a>
      </div>

      <a href="/" style={{ display: "block", marginTop: "20px" }}>
        ← Back to Home
      </a>
    </div>
  );
}

// Test layout component
export function TestLayout({ children }: { children?: React.ReactNode }) {
  return (
    <div
      style={{
        border: "3px solid #4CAF50",
        borderRadius: "8px",
        margin: "20px",
        padding: "20px",
        backgroundColor: "#f0f8f0",
      }}
    >
      <div
        style={{
          borderBottom: "2px solid #4CAF50",
          paddingBottom: "10px",
          marginBottom: "20px",
        }}
      >
        <h1 style={{ color: "#2E7D32", margin: 0 }}>
          🧪 Test Layout Container
        </h1>
        <p style={{ color: "#666", marginTop: "5px" }}>
          This green border persists when navigating between test pages
        </p>
      </div>

      <div>{children}</div>

      <div
        style={{
          borderTop: "2px solid #4CAF50",
          paddingTop: "10px",
          marginTop: "20px",
          color: "#666",
        }}
      >
        <small>Test Layout Footer - I stay here!</small>
      </div>
    </div>
  );
}
