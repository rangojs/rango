"use server";

// Server-side data fetching function
async function fetchDynamicContent() {
  // Simulate fetching data from an API or database
  // In a real app, this could be a database query or external API call
  const timestamp = new Date().toISOString();

  // Simulating async data fetch
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Get server info (these will be available in the server environment)
  const serverInfo = {
    nodeVersion: typeof process !== "undefined" ? process.version : "N/A",
    platform: typeof process !== "undefined" ? process.platform : "N/A",
  };

  return {
    title: "Dynamic RSC Content",
    timestamp,
    items: [
      {
        id: 1,
        name: "Server Item 1",
        description: "This content was fetched on the server",
      },
      {
        id: 2,
        name: "Server Item 2",
        description: "RSC allows direct database access",
      },
      { id: 3, name: "Server Item 3", description: "No API routes needed!" },
    ],
    serverInfo,
  };
}

// Server Component that fetches and renders content
export async function Homepage() {
  // Fetch data directly in the component (this runs on the server)
  const content = await fetchDynamicContent();

  return (
    <div className="homepage">
      <h2>{content.title}</h2>
      <p className="timestamp">Rendered at: {content.timestamp}</p>

      <div className="server-info">
        <h3>Server Information:</h3>
        <p>Node Version: {content.serverInfo.nodeVersion}</p>
        <p>Platform: {content.serverInfo.platform}</p>
      </div>

      <div className="content-list">
        <h3>Dynamic Content Items:</h3>
        <ul>
          {content.items.map((item) => (
            <li key={item.id}>
              <strong>{item.name}</strong>
              <p>{item.description}</p>
            </li>
          ))}
        </ul>
      </div>

      <div className="rsc-features">
        <h3>RSC Features Demonstrated:</h3>
        <ul>
          <li>✅ Direct server-side data fetching</li>
          <li>✅ No client-server waterfall</li>
          <li>✅ Automatic streaming</li>
          <li>✅ Zero client-side JavaScript for this component</li>
        </ul>
      </div>
    </div>
  );
}

// Optional: Export a loading component for Suspense boundaries
export async function HomepageLoading() {
  return (
    <div className="homepage-loading">
      <p>Loading homepage content...</p>
    </div>
  );
}
