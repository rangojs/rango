import { Outlet } from 'rsc-router/client';

export function ShopLayout() {
  return (
    <div>
      <header style={{
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        color: 'white',
        padding: '1.5rem',
        marginBottom: '2rem',
        borderRadius: '8px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ margin: 0, color: 'white' }}>🛍️ Shop</h1>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <a href="/shop" style={{ color: 'white', textDecoration: 'none' }}>Products</a>
            <a href="/shop/cart" style={{ color: 'white', textDecoration: 'none' }}>Cart (0)</a>
            <a href="/shop/account" style={{ color: 'white', textDecoration: 'none' }}>Account</a>
          </div>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
