import { Outlet } from 'rsc-router/client';
import { DebugSegmentWrapper } from '../components/DebugSegmentWrapper.js';

export function CheckoutLayout() {
  // In a real app, we'd get the current step from the route
  // For demo purposes, showing all steps
  const steps = ['Cart', 'Payment', 'Confirm'];

  return (
    <DebugSegmentWrapper type="layout" name="Checkout">
      <div>
        <div style={{
          background: '#f8f9fa',
          padding: '1.5rem',
          marginBottom: '2rem',
          borderRadius: '8px',
        }}>
          <h2 style={{ margin: '0 0 1rem 0' }}>Checkout Progress</h2>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            {steps.map((step, index) => (
              <div key={step} style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  background: index === 0 ? '#667eea' : '#e9ecef',
                  color: index === 0 ? 'white' : '#6c757d',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 'bold',
                }}>
                  {index + 1}
                </div>
                <span style={{ color: index === 0 ? '#333' : '#6c757d' }}>{step}</span>
                {index < steps.length - 1 && (
                  <span style={{ color: '#dee2e6', margin: '0 0.5rem' }}>→</span>
                )}
              </div>
            ))}
          </div>
        </div>
        <DebugSegmentWrapper type="outlet" name="Checkout Outlet">
          <Outlet />
        </DebugSegmentWrapper>
      </div>
    </DebugSegmentWrapper>
  );
}
