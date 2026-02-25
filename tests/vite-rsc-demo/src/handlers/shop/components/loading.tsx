"use client";
import { useNavigation } from "@rangojs/router/client";

export const LoadingSpinner = () => {
  const { isStreaming, state, isLoading, isLoadingOrStreaming } = useNavigation(
    (nav) => ({
      isStreaming: nav.isStreaming,
      state: nav.state,
      isLoading: nav.state === "loading",
      isLoadingOrStreaming: nav.state === "loading" || nav.isStreaming,
    }),
  );

  console.log("LoadingSpinner", {
    state,
    isStreaming,
    isLoading,
    isLoadingOrStreaming,
  });

  return (
    <div
      style={{
        marginTop: "1rem",
        fontSize: "0.9rem",
        color: "#555",
        height: "1.5rem",
      }}
    >
      {isLoading && <span>Loading...</span>}
      {isStreaming && <span>Streaming...</span>}
    </div>
  );
};

// Skeleton components for loading states
const skeletonStyle = {
  background: "linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)",
  backgroundSize: "200% 100%",
  animation: "shimmer 1.5s infinite",
  borderRadius: "4px",
};

export const ProductCardSkeleton = () => (
  <div
    style={{ padding: "1rem", border: "1px solid #eee", borderRadius: "8px" }}
  >
    <div style={{ ...skeletonStyle, height: "200px", marginBottom: "1rem" }} />
    <div
      style={{
        ...skeletonStyle,
        height: "20px",
        width: "80%",
        marginBottom: "0.5rem",
      }}
    />
    <div style={{ ...skeletonStyle, height: "16px", width: "40%" }} />
  </div>
);

export const ProductDetailSkeleton = () => (
  <div style={{ display: "flex", gap: "2rem", padding: "2rem" }}>
    <div style={{ ...skeletonStyle, width: "400px", height: "400px" }} />
    <div style={{ flex: 1 }}>
      <div
        style={{
          ...skeletonStyle,
          height: "32px",
          width: "60%",
          marginBottom: "1rem",
        }}
      />
      <div
        style={{
          ...skeletonStyle,
          height: "24px",
          width: "30%",
          marginBottom: "1rem",
        }}
      />
      <div
        style={{
          ...skeletonStyle,
          height: "16px",
          width: "90%",
          marginBottom: "0.5rem",
        }}
      />
      <div
        style={{
          ...skeletonStyle,
          height: "16px",
          width: "85%",
          marginBottom: "0.5rem",
        }}
      />
      <div
        style={{
          ...skeletonStyle,
          height: "16px",
          width: "70%",
          marginBottom: "2rem",
        }}
      />
      <div style={{ ...skeletonStyle, height: "48px", width: "150px" }} />
    </div>
  </div>
);

export const CartSkeleton = () => (
  <div style={{ padding: "2rem" }}>
    <div
      style={{
        ...skeletonStyle,
        height: "28px",
        width: "120px",
        marginBottom: "1.5rem",
      }}
    />
    {[1, 2, 3].map((i) => (
      <div
        key={i}
        style={{
          display: "flex",
          gap: "1rem",
          marginBottom: "1rem",
          padding: "1rem",
          border: "1px solid #eee",
          borderRadius: "8px",
        }}
      >
        <div style={{ ...skeletonStyle, width: "100px", height: "100px" }} />
        <div style={{ flex: 1 }}>
          <div
            style={{
              ...skeletonStyle,
              height: "20px",
              width: "60%",
              marginBottom: "0.5rem",
            }}
          />
          <div style={{ ...skeletonStyle, height: "16px", width: "30%" }} />
        </div>
      </div>
    ))}
  </div>
);

export const CheckoutSkeleton = () => (
  <div style={{ padding: "2rem" }}>
    <div
      style={{
        ...skeletonStyle,
        height: "28px",
        width: "150px",
        marginBottom: "1.5rem",
      }}
    />
    <div
      style={{
        ...skeletonStyle,
        height: "48px",
        width: "100%",
        marginBottom: "1rem",
      }}
    />
    <div
      style={{
        ...skeletonStyle,
        height: "48px",
        width: "100%",
        marginBottom: "1rem",
      }}
    />
    <div
      style={{
        ...skeletonStyle,
        height: "48px",
        width: "100%",
        marginBottom: "2rem",
      }}
    />
    <div style={{ ...skeletonStyle, height: "48px", width: "200px" }} />
  </div>
);

export const ShopLayoutSkeleton = () => (
  <div style={{ padding: "1rem" }}>
    <div
      style={{
        ...skeletonStyle,
        height: "24px",
        width: "200px",
        marginBottom: "1rem",
      }}
    />
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: "1rem",
      }}
    >
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <ProductCardSkeleton key={i} />
      ))}
    </div>
  </div>
);

export const ProductModalSkeleton = () => (
  <div
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.5)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 1000,
    }}
  >
    <div
      style={{
        background: "white",
        borderRadius: "12px",
        width: "90%",
        maxWidth: "500px",
        overflow: "hidden",
        boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)",
      }}
    >
      <div
        style={{
          padding: "1.5rem",
          background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
        }}
      >
        <div
          style={{
            ...skeletonStyle,
            height: "24px",
            width: "60%",
            background: "rgba(255,255,255,0.3)",
          }}
        />
      </div>
      <div style={{ padding: "1.5rem" }}>
        <div
          style={{
            ...skeletonStyle,
            height: "32px",
            width: "40%",
            marginBottom: "1rem",
          }}
        />
        <div
          style={{
            ...skeletonStyle,
            height: "16px",
            width: "100%",
            marginBottom: "0.5rem",
          }}
        />
        <div
          style={{
            ...skeletonStyle,
            height: "16px",
            width: "90%",
            marginBottom: "0.5rem",
          }}
        />
        <div
          style={{
            ...skeletonStyle,
            height: "16px",
            width: "75%",
            marginBottom: "1.5rem",
          }}
        />
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <div style={{ ...skeletonStyle, height: "44px", flex: 1 }} />
          <div style={{ ...skeletonStyle, height: "44px", width: "80px" }} />
        </div>
      </div>
    </div>
  </div>
);
