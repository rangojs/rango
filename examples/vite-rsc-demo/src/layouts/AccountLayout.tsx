import { Outlet } from 'rsc-router/client';

export function AccountLayout() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', gap: '2rem' }}>
      <aside style={{
        background: '#f8f9fa',
        padding: '1.5rem',
        borderRadius: '8px',
        height: 'fit-content',
      }}>
        <h3 style={{ marginTop: 0 }}>My Account</h3>
        <nav style={{ background: 'transparent', padding: 0, margin: 0 }}>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            <li style={{ marginBottom: '0.5rem' }}>
              <a href="/shop/account" style={{
                display: 'block',
                padding: '0.5rem',
                borderRadius: '4px',
                textDecoration: 'none',
              }}>
                Dashboard
              </a>
            </li>
            <li style={{ marginBottom: '0.5rem' }}>
              <a href="/shop/account/orders" style={{
                display: 'block',
                padding: '0.5rem',
                borderRadius: '4px',
                textDecoration: 'none',
              }}>
                Order History
              </a>
            </li>
          </ul>
        </nav>
      </aside>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
