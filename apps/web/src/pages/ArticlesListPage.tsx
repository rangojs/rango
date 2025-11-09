import React from 'react';

export default function ArticlesListPage() {
  console.log('[ArticlesListPage] Rendering');

  const articles = [
    { id: 1, title: 'Getting Started with RSC', date: '2024-01-15' },
    { id: 2, title: 'Building Nested Layouts', date: '2024-01-14' },
    { id: 3, title: 'Partial Rendering Explained', date: '2024-01-13' },
  ];

  return (
    <div>
      <h2>All Articles</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
        {articles.map(article => (
          <article
            key={article.id}
            style={{
              padding: '1rem',
              border: '1px solid #ddd',
              borderRadius: '8px'
            }}
          >
            <h3>{article.title}</h3>
            <p style={{ color: '#666' }}>Published on {article.date}</p>
            <a href={`/articles/${article.id}`}>Read more →</a>
          </article>
        ))}
      </div>
    </div>
  );
}