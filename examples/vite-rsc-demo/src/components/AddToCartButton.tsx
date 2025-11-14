'use client'

import { useState, useTransition } from 'react';

export function AddToCartButton({
  productId,
  action,
}: {
  productId: string;
  action: (productId: string, quantity: number) => Promise<any>;
}) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<any>(null);

  const handleClick = () => {
    startTransition(async () => {
      try {
        const data = await action(productId, 1);
        console.log('[AddToCartButton] Action returned:', data);
        setResult(data);
      } catch (error) {
        console.error('[AddToCartButton] Action failed:', error);
        setResult({ error: String(error) });
      }
    });
  };

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={isPending}
        style={{
          background: isPending ? '#ccc' : '#28a745',
          color: 'white',
          border: 'none',
          padding: '0.75rem 1.5rem',
          borderRadius: '4px',
          fontSize: '1rem',
          cursor: isPending ? 'not-allowed' : 'pointer',
          marginTop: '1rem',
        }}
      >
        {isPending ? 'Adding...' : 'Add to Cart (with returnValue)'}
      </button>

      {result && (
        <div
          style={{
            marginTop: '1rem',
            padding: '1rem',
            background: result.error ? '#f8d7da' : '#d4edda',
            border: `1px solid ${result.error ? '#f5c6cb' : '#c3e6cb'}`,
            borderRadius: '4px',
          }}
        >
          <h4 style={{ margin: '0 0 0.5rem 0' }}>
            {result.error ? '❌ Error' : '✅ Success'}
          </h4>
          {result.error ? (
            <p style={{ margin: 0 }}>{result.error}</p>
          ) : (
            <>
              <p style={{ margin: '0 0 0.5rem 0' }}><strong>{result.message}</strong></p>
              <ul style={{ margin: 0, paddingLeft: '1.5rem', fontSize: '0.9rem' }}>
                <li>Product: {result.cart.productId}</li>
                <li>Previous quantity: {result.cart.previousQuantity}</li>
                <li>New quantity: {result.cart.newQuantity}</li>
                <li>Total items in cart: {result.cart.totalItems}</li>
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
