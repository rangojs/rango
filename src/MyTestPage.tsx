'use server'

// This is a dedicated RSC component for the /my-test route
export async function MyTestPage() {
  // Simulate fetching specific data for this route
  const timestamp = new Date().toISOString()

  // Simulate async data fetching
  await new Promise(resolve => setTimeout(resolve, 500))

  // You can fetch any data here - database queries, API calls, etc.
  const testData = {
    pageTitle: 'My Test Page',
    content: 'This is RSC content loaded from /my-test path!',
    timestamp,
    features: [
      'Loaded via dynamic routing',
      'Server-side rendered',
      'No client-side JavaScript needed',
      'Can access databases directly'
    ],
    randomNumber: Math.floor(Math.random() * 1000)
  }

  return (
    <div className="my-test-page">
      <h1>{testData.pageTitle}</h1>
      <p className="test-content">{testData.content}</p>

      <div className="test-info">
        <p><strong>Rendered at:</strong> {testData.timestamp}</p>
        <p><strong>Random Number:</strong> {testData.randomNumber}</p>

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
  )
}