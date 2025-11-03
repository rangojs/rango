'use server'

// Example of fetching external data in RSC
async function fetchGitHubData() {
  try {
    // This runs on the server, so we can directly fetch external APIs
    // without CORS issues
    const response = await fetch('https://api.github.com/repos/vitejs/vite')

    if (!response.ok) {
      throw new Error('Failed to fetch')
    }

    const data = await response.json()

    return {
      name: data.name,
      description: data.description,
      stars: data.stargazers_count,
      language: data.language,
      url: data.html_url,
      lastUpdated: new Date(data.updated_at).toLocaleDateString()
    }
  } catch (error) {
    console.error('Error fetching GitHub data:', error)
    return null
  }
}

// Example of simulating a database query
async function fetchDatabaseRecords() {
  // Simulate database latency
  await new Promise(resolve => setTimeout(resolve, 200))

  // In a real app, this would be something like:
  // const records = await db.query('SELECT * FROM posts ORDER BY created_at DESC LIMIT 5')

  return [
    { id: 1, title: 'First Post', views: 150, created: '2024-01-15' },
    { id: 2, title: 'React Server Components', views: 320, created: '2024-01-20' },
    { id: 3, title: 'Vite RSC Plugin', views: 280, created: '2024-01-25' },
  ]
}

export async function AdvancedRscExample() {
  // Fetch data in parallel for better performance
  const [githubData, dbRecords] = await Promise.all([
    fetchGitHubData(),
    fetchDatabaseRecords()
  ])

  return (
    <div className="advanced-example">
      <h2>Advanced RSC Fetching Examples</h2>

      {/* External API Data */}
      <div className="api-data">
        <h3>External API Data (GitHub)</h3>
        {githubData ? (
          <div className="github-info">
            <p><strong>Repository:</strong> <a href={githubData.url} target="_blank">{githubData.name}</a></p>
            <p><strong>Description:</strong> {githubData.description}</p>
            <p><strong>Stars:</strong> ⭐ {githubData.stars?.toLocaleString()}</p>
            <p><strong>Language:</strong> {githubData.language}</p>
            <p><strong>Last Updated:</strong> {githubData.lastUpdated}</p>
          </div>
        ) : (
          <p>Failed to load GitHub data</p>
        )}
      </div>

      {/* Database Records */}
      <div className="db-data">
        <h3>Simulated Database Records</h3>
        <table className="records-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Title</th>
              <th>Views</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {dbRecords.map(record => (
              <tr key={record.id}>
                <td>{record.id}</td>
                <td>{record.title}</td>
                <td>{record.views}</td>
                <td>{record.created}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="advantages">
        <h3>RSC Advantages Demonstrated:</h3>
        <ul>
          <li>✅ Direct server-side API calls (no CORS issues)</li>
          <li>✅ Parallel data fetching with Promise.all</li>
          <li>✅ Database queries without API endpoints</li>
          <li>✅ Sensitive operations stay on the server</li>
          <li>✅ Smaller client bundle (no fetch libraries needed)</li>
        </ul>
      </div>
    </div>
  )
}