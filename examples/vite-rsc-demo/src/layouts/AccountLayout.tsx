import { Outlet, ParallelOutlet } from 'rsc-router/client';
import { DebugSegmentWrapper } from '../components/DebugSegmentWrapper.js';

export function AccountLayout() {
  return (
    <DebugSegmentWrapper type="layout" name="Account">
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
          <DebugSegmentWrapper type="outlet" name="Account Outlet">
            <Outlet />
          </DebugSegmentWrapper>
          {/* Recent orders parallel slot - renders after main content */}
          <ParallelOutlet name="@orders" />
        </main>
      </div>
    </DebugSegmentWrapper>
  );
}
